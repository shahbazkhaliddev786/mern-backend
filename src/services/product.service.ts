import { Types } from 'mongoose';
import { Product } from '../models/index.js';
import cloudinary from '../utils/cloudinary.js';
import bufferGenerator from '../utils/buffer.generator.js';
import logger from '../utils/logger.js';

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
  const CategoryModel = Product.db.model('Category');
  const BrandModel = Product.db.model('Brand');

  const categoryDoc = await CategoryModel.findById(category);
  const brandDoc = await BrandModel.findById(brand);

  if (!categoryDoc || !brandDoc) {
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

  const product = await Product.create({
    name: trimmedName,
    description: trimmedDescription,
    price: Number(price),
    stock: Number(stock || 0),
    category,
    brand,
    images,
  });

  const populatedProduct = await Product.findById(product._id)
    .populate([
      { path: 'category', select: 'name' },
      { path: 'brand', select: 'name' },
    ])
    .select('-__v')
    .lean();

  if (!populatedProduct) {
    throw new Error('Failed to retrieve created product');
  }

  return populatedProduct;
};

export const getAllProductsService = async () => {
  return await Product.find()
    .sort({ createdAt: -1 })
    .populate([
      { path: 'category', select: 'name' },
      { path: 'brand', select: 'name' },
    ])
    .select('-__v')
    .lean();
};

export const getProductByIdService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid product ID format');
  }

  const product = await Product.findById(id)
    .populate([
      { path: 'category', select: 'name' },
      { path: 'brand', select: 'name' },
    ])
    .select('-__v')
    .lean();

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
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid product ID format');
  }

  const product = await Product.findById(id);
  if (!product) {
    throw new Error('Product not found');
  }

  // Validate and convert category if provided
  if (updates.category) {
    if (!Types.ObjectId.isValid(updates.category)) {
      throw new Error('Invalid category ID format');
    }
    const cat = await Product.db.model('Category').findById(updates.category);
    if (!cat) throw new Error('Invalid category ID');
    product.category = new Types.ObjectId(updates.category); // ← Fixed: convert string to ObjectId
  }

  // Validate and convert brand if provided
  if (updates.brand) {
    if (!Types.ObjectId.isValid(updates.brand)) {
      throw new Error('Invalid brand ID format');
    }
    const br = await Product.db.model('Brand').findById(updates.brand);
    if (!br) throw new Error('Invalid brand ID');
    product.brand = new Types.ObjectId(updates.brand); // ← Fixed: convert string to ObjectId
  }

  // Handle image replacement (delete old, upload new)
  if (files && files.length > 0) {
    // Delete old images from Cloudinary
    if (product.images.length > 0) {
      const deletePromises = product.images.map((url) => {
        const parts = url.split('/');
        const filenameWithExt = parts.at(-1);
        if (!filenameWithExt) {
          logger.warn('Invalid image URL format, skipping delete', { url });
          return Promise.resolve();
        }

        const publicId = 'products/' + filenameWithExt.split('.')[0];

        return cloudinary.uploader.destroy(publicId).catch((err: any) => {
          logger.warn('Failed to delete old image from Cloudinary', {
            publicId,
            error: err.message,
          });
        });
      });

      await Promise.all(deletePromises);
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

    product.images = await Promise.all(uploadPromises);
  }

  // Apply text field updates
  if (updates.name !== undefined) product.name = updates.name.trim();
  if (updates.description !== undefined) product.description = updates.description.trim();
  if (updates.price !== undefined) product.price = Number(updates.price);
  if (updates.stock !== undefined) product.stock = Number(updates.stock);

  await product.save();

  const populatedProduct = await Product.findById(product._id)
    .populate([
      { path: 'category', select: 'name' },
      { path: 'brand', select: 'name' },
    ])
    .select('-__v')
    .lean();

  if (!populatedProduct) {
    throw new Error('Failed to retrieve updated product');
  }

  return populatedProduct;
};

export const deleteProductService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid product ID format');
  }

  const product = await Product.findById(id);
  if (!product) {
    throw new Error('Product not found');
  }

  // Delete images from Cloudinary
  if (product.images.length > 0) {
    const deletePromises = product.images.map((url) => {
      const parts = url.split('/');
      const filenameWithExt = parts.at(-1);
      if (!filenameWithExt) return Promise.resolve();

      const publicId = 'products/' + filenameWithExt.split('.')[0];
      return cloudinary.uploader.destroy(publicId).catch(() => {});
    });
    await Promise.all(deletePromises);
  }

  await Product.findByIdAndDelete(id);

  return product;
};