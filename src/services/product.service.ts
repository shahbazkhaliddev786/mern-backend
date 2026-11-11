import { and, asc, count, desc, eq, gt, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { brands, categories, products } from '../db/schema/index.js';
import cloudinary from '../utils/cloudinary.js';
import bufferGenerator from '../utils/buffer.generator.js';
import { isId } from '../utils/ids.js';
import logger from '../utils/logger.js';
import { findProducts } from './shapes.js';

const findProduct = async (id: string) => (await findProducts({ where: eq(products.id, id) }))[0];
const exists = async (table: typeof categories | typeof brands, id: string) =>
  isId(id) && (await getDb().select({ id: table.id }).from(table).where(eq(table.id, id))).length > 0;

// Deletes product images from Cloudinary; a failed delete is skipped (and logged on update).
const deleteImages = async (images: string[], logFailures: boolean) => {
  const deletePromises = images.map((url) => {
    const parts = url.split('/');
    const filenameWithExt = parts.at(-1);
    if (!filenameWithExt) {
      if (logFailures) logger.warn('Invalid image URL format, skipping delete', { url });
      return Promise.resolve();
    }

    const publicId = 'products/' + filenameWithExt.split('.')[0];

    return cloudinary.uploader.destroy(publicId).catch((err: any) => {
      if (logFailures) {
        logger.warn('Failed to delete old image from Cloudinary', {
          publicId,
          error: err.message,
        });
      }
    });
  });

  await Promise.all(deletePromises);
};

export const createProductService = async (
  name: string,
  description: string,
  price: number,
  stock: number,
  category: string,
  brand: string,
  files?: Express.Multer.File[]
) => {
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  // Validate category & brand existence
  if (!(await exists(categories, category)) || !(await exists(brands, brand))) {
    throw new Error('Invalid category or brand ID');
  }

  let images: string[] = [];

  if (files && files.length > 0) {
    const uploadPromises = files.map(async (file) => {
      const dataUri = bufferGenerator(file);
      if (!dataUri?.content) {
        throw new Error('Failed to generate data URI for uploaded file');
      }

      const result = await cloudinary.uploader.upload(dataUri.content, {
        folder: 'products',
        resource_type: 'image',
      });

      return result.secure_url;
    });

    images = await Promise.all(uploadPromises);
  }

  const [created] = await getDb()
    .insert(products)
    .values({
      name: trimmedName,
      description: trimmedDescription,
      price: Number(price),
      stock: Number(stock || 0),
      categoryId: category,
      brandId: brand,
      images,
    })
    .returning({ id: products.id });

  const populatedProduct = await findProduct(created!.id);
  if (!populatedProduct) {
    throw new Error('Failed to retrieve created product');
  }

  return populatedProduct;
};

// Category and brand filters take ids; an id that isn't one matches nothing.
const idFilter = (value: string | string[] | undefined): string[] | undefined => {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.length === 0 ? undefined : list.filter(isId);
};

export const getAllProductsService = async ({
  search,
  category,
  brand,
  minPrice,
  maxPrice,
  sort = 'newest',
  page = 1,
  limit = 20,
  inStock,
}: {
  search?: string;
  category?: string | string[];
  brand?: string | string[];
  minPrice?: number;
  maxPrice?: number;
  sort?: 'relevance' | 'price_low' | 'price_high' | 'newest' | 'best_selling';
  page?: number;
  limit?: number;
  // Only products with stock > 0. Used by the agent's search_products; the REST route doesn't pass it.
  inStock?: boolean;
} = {}) => {
  const conditions: SQL[] = [];
  const term = search?.trim();

  // Text search on name and description: a case-insensitive pattern, as the Mongo regex was.
  if (term) {
    conditions.push(or(sql`${products.name} ~* ${term}`, sql`${products.description} ~* ${term}`)!);
  }

  // Category and brand filters (multi-select)
  const categoryIds = idFilter(category);
  if (categoryIds) conditions.push(categoryIds.length ? inArray(products.categoryId, categoryIds) : sql`false`);
  const brandIds = idFilter(brand);
  if (brandIds) conditions.push(brandIds.length ? inArray(products.brandId, brandIds) : sql`false`);

  // Price range
  if (minPrice !== undefined) conditions.push(gte(products.price, Number(minPrice)));
  if (maxPrice !== undefined) conditions.push(lte(products.price, Number(maxPrice)));

  if (inStock) conditions.push(gt(products.stock, 0));

  // Sorting; ties keep the newest first.
  let orderBy: SQL[];
  switch (sort) {
    case 'relevance':
      // Name matches first, then description matches, then newest.
      orderBy = term
        ? [sql`(${products.name} ~* ${term}) desc`, sql`(${products.description} ~* ${term}) desc`, desc(products.createdAt)]
        : [desc(products.createdAt)];
      break;
    case 'price_low':
      orderBy = [asc(products.price), desc(products.createdAt)];
      break;
    case 'price_high':
      orderBy = [desc(products.price), desc(products.createdAt)];
      break;
    case 'best_selling':
      // TODO: add a sales count to products later
      orderBy = [desc(products.createdAt)]; // fallback for now
      break;
    case 'newest':
    default:
      orderBy = [desc(products.createdAt)];
      break;
  }

  // Pagination
  const limitNum = Number(limit);
  const skip = (Number(page) - 1) * limitNum;
  const where = conditions.length ? and(...conditions) : undefined;

  const found = await findProducts({ where, orderBy, limit: limitNum, offset: skip });

  // Total count for pagination metadata
  const [counted] = await getDb().select({ total: count() }).from(products).where(where);
  const total = counted?.total ?? 0;

  return {
    products: found,
    pagination: {
      currentPage: Number(page),
      totalPages: Math.ceil(total / limitNum),
      totalItems: total,
      hasNext: skip + found.length < total,
      hasPrev: Number(page) > 1,
    },
  };
};

export const getProductByIdService = async (id: string) => {
  if (!isId(id)) {
    throw new Error('Invalid product ID format');
  }

  const product = await findProduct(id);
  if (!product) {
    throw new Error('Product not found');
  }

  return product;
};

export const updateProductService = async (
  id: string,
  updates: {
    name?: string;
    description?: string;
    price?: number;
    stock?: number;
    category?: string;
    brand?: string;
  },
  files?: Express.Multer.File[]
) => {
  if (!isId(id)) {
    throw new Error('Invalid product ID format');
  }

  const [product] = await getDb().select().from(products).where(eq(products.id, id));
  if (!product) {
    throw new Error('Product not found');
  }

  const changes: Partial<typeof products.$inferInsert> = {};

  // Validate category if provided
  if (updates.category) {
    if (!isId(updates.category)) {
      throw new Error('Invalid category ID format');
    }
    if (!(await exists(categories, updates.category))) throw new Error('Invalid category ID');
    changes.categoryId = updates.category;
  }

  // Validate brand if provided
  if (updates.brand) {
    if (!isId(updates.brand)) {
      throw new Error('Invalid brand ID format');
    }
    if (!(await exists(brands, updates.brand))) throw new Error('Invalid brand ID');
    changes.brandId = updates.brand;
  }

  // Handle image replacement (delete old, upload new)
  if (files && files.length > 0) {
    // Delete old images from Cloudinary
    if (product.images.length > 0) {
      await deleteImages(product.images, true);
    }

    // Upload new images
    const uploadPromises = files.map(async (file) => {
      const dataUri = bufferGenerator(file);
      if (!dataUri?.content) {
        throw new Error('Failed to generate data URI');
      }

      const result = await cloudinary.uploader.upload(dataUri.content, {
        folder: 'products',
      });

      return result.secure_url;
    });

    changes.images = await Promise.all(uploadPromises);
  }

  // Apply text field updates
  if (updates.name !== undefined) changes.name = updates.name.trim();
  if (updates.description !== undefined) changes.description = updates.description.trim();
  if (updates.price !== undefined) changes.price = Number(updates.price);
  if (updates.stock !== undefined) changes.stock = Number(updates.stock);

  // updatedAt moves on every save, as Mongoose's timestamps did.
  await getDb()
    .update(products)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(products.id, id));

  const populatedProduct = await findProduct(id);
  if (!populatedProduct) {
    throw new Error('Failed to retrieve updated product');
  }

  return populatedProduct;
};

export const deleteProductService = async (id: string) => {
  if (!isId(id)) {
    throw new Error('Invalid product ID format');
  }

  const product = await findProduct(id);
  if (!product) {
    throw new Error('Product not found');
  }

  // Delete images from Cloudinary
  if (product.images.length > 0) {
    await deleteImages(product.images, false);
  }

  await getDb().delete(products).where(eq(products.id, id));

  return product;
};
