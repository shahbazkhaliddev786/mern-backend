// The API's record shapes (spec 023). Responses keep the shapes the Mongo version sent, so the
// frontend and the agent's tools don't change: `_id` rather than `id`, references expanded to
// `{ _id, name }` where Mongoose populated them, and empty optional fields left out.

import { asc, eq, inArray, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { brands, categories, products, type OrderItem, type ShippingAddress } from '../db/schema/index.js';

type Row<T> = T & Record<string, unknown>;

/** Drops null and undefined fields, as JSON did for fields a Mongo document didn't have. */
export function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined)) as T;
}

export interface ApiRef {
  _id: string;
  name: string;
}

export const apiNamed = (row: { id: string; name: string; createdAt: Date; updatedAt: Date }) => ({
  _id: row.id,
  name: row.name,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export interface ApiProduct {
  _id: string;
  name: string;
  description: string;
  price: number;
  images: string[];
  stock: number;
  category: ApiRef | null;
  brand: ApiRef | null;
  createdAt: Date;
  updatedAt: Date;
}

const productColumns = {
  id: products.id,
  name: products.name,
  description: products.description,
  price: products.price,
  images: products.images,
  stock: products.stock,
  categoryId: products.categoryId,
  brandId: products.brandId,
  categoryName: categories.name,
  brandName: brands.name,
  createdAt: products.createdAt,
  updatedAt: products.updatedAt,
};

type ProductRow = {
  id: string;
  name: string;
  description: string;
  price: number;
  images: string[];
  stock: number;
  categoryId: string;
  brandId: string;
  categoryName: string | null;
  brandName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export const apiProduct = (row: ProductRow): ApiProduct => ({
  _id: row.id,
  name: row.name,
  description: row.description,
  price: row.price,
  images: row.images,
  stock: row.stock,
  category: row.categoryName === null ? null : { _id: row.categoryId, name: row.categoryName },
  brand: row.brandName === null ? null : { _id: row.brandId, name: row.brandName },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Products with their category and brand names, as Mongoose's populate gave them. */
export async function findProducts(
  options: { where?: SQL | undefined; orderBy?: SQL[]; limit?: number; offset?: number } = {},
): Promise<ApiProduct[]> {
  let query = getDb()
    .select(productColumns)
    .from(products)
    .leftJoin(categories, eq(products.categoryId, categories.id))
    .leftJoin(brands, eq(products.brandId, brands.id))
    .$dynamic();
  if (options.where) query = query.where(options.where);
  query = query.orderBy(...(options.orderBy ?? [asc(products.createdAt)]));
  if (options.limit !== undefined) query = query.limit(options.limit);
  if (options.offset !== undefined) query = query.offset(options.offset);
  return ((await query) as ProductRow[]).map(apiProduct);
}

/** A cart line's product: the fields Mongoose's cart populate selected (no description or dates). */
export type ApiCartProduct = Pick<ApiProduct, '_id' | 'name' | 'price' | 'images' | 'stock' | 'category' | 'brand'>;

export const cartProduct = (product: ApiProduct): ApiCartProduct => ({
  _id: product._id,
  name: product.name,
  price: product.price,
  images: product.images,
  stock: product.stock,
  category: product.category,
  brand: product.brand,
});

/** The products with these ids, by id; missing ids are simply absent. */
export async function productsById(ids: string[]): Promise<Map<string, ApiProduct>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const found = await findProducts({ where: inArray(products.id, unique) });
  return new Map(found.map((product) => [product._id, product]));
}

export interface ApiUser {
  _id: string;
  name: string;
  email: string;
  profile?: string;
  isVerified: boolean;
  role: 'user' | 'admin';
  createdAt: Date;
  updatedAt: Date;
}

/** A user without the password, tokens or pending-email secrets. */
export const apiUser = (row: Row<{ id: string; name: string; email: string; profile: string | null; isVerified: boolean; role: 'user' | 'admin'; createdAt: Date; updatedAt: Date }>): ApiUser =>
  compact({
    _id: row.id,
    name: row.name,
    email: row.email,
    profile: row.profile,
    isVerified: row.isVerified,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }) as ApiUser;

export interface ApiOrder {
  _id: string;
  user: string | ApiRefUser | null;
  items: (Omit<OrderItem, 'product'> & { product: unknown })[];
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  stripeSessionId?: string;
  shippingAddress: ShippingAddress;
  paidAt?: Date;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiRefUser {
  _id: string;
  name: string;
  email: string;
}

type OrderRow = {
  id: string;
  userId: string | null;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  stripeSessionId: string | null;
  shippingAddress: ShippingAddress;
  paidAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * An order as the API sends it. `user` is the id unless an expanded user is given; each item's
 * `product` is the id unless `product` maps it to an expanded product (null when deleted).
 */
export function apiOrder(row: OrderRow, expand: { user?: ApiRefUser | null; product?: (id: string) => unknown } = {}): ApiOrder {
  const order = compact({
    _id: row.id,
    items: row.items.map((item) => ({ ...item, product: expand.product ? expand.product(item.product) : item.product })),
    subtotal: row.subtotal,
    tax: row.tax,
    shipping: row.shipping,
    total: row.total,
    status: row.status,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    stripeSessionId: row.stripeSessionId,
    shippingAddress: row.shippingAddress,
    paidAt: row.paidAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  // `user` stays even when empty: a deleted customer's order shows `user: null`, as populate did.
  const { _id, ...rest } = order;
  return { _id, user: expand.user !== undefined ? expand.user : row.userId, ...rest } as ApiOrder;
}

/** A product row as Mongoose's plain populate gave it: every field, with category and brand as ids. */
export const rawProduct = (row: typeof products.$inferSelect) => ({
  _id: row.id,
  name: row.name,
  description: row.description,
  price: row.price,
  images: row.images,
  stock: row.stock,
  category: row.categoryId,
  brand: row.brandId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** The `{ _id, name, price, images }` Mongoose gave for `populate('items.product', 'name images price')`. */
export const productSummary = (product: ApiProduct | undefined) =>
  product ? { _id: product._id, name: product.name, price: product.price, images: product.images } : null;

/** Sorted by name, as the Mongo lists of categories and brands were. */
export const byName = (table: typeof categories | typeof brands) => [asc(table.name)];
