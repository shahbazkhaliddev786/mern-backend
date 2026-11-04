// The store's tables (spec 023), translated from the Mongoose models one for one. Ids are UUIDs;
// money is numeric(10,2), read as a number; arrays that are only ever read with their parent
// (order items, the address snapshot) stay as jsonb, while cart items, which change one at a
// time, are their own table.

import { sql } from 'drizzle-orm';
import { boolean, check, customType, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const money = (name: string) => numeric(name, { precision: 10, scale: 2, mode: 'number' });
const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export interface ShippingAddress {
  fullName: string;
  address: string;
  apartment?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

/**
 * A line of an order or a pending checkout: a snapshot of the product when it was bought. Each
 * line has its own `_id`, as the Mongo subdocuments did, so the API keeps returning one.
 */
export interface OrderItem {
  _id: string;
  product: string;
  name: string;
  price: number;
  quantity: number;
  image?: string;
}

export const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed'] as const;

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    // Stored lowercase and trimmed by the services, as the Mongoose schema did.
    email: text('email').notNull().unique(),
    password: text('password').notNull(),
    profile: text('profile'),
    isVerified: boolean('is_verified').notNull().default(false),
    refreshTokens: text('refresh_tokens').array().notNull().default(sql`'{}'::text[]`),
    role: text('role', { enum: ['user', 'admin'] }).notNull().default('user'),
    pendingEmail: text('pending_email'),
    pendingEmailOtpHash: text('pending_email_otp_hash'),
    pendingEmailExpiresAt: timestamp('pending_email_expires_at', { withTimezone: true }),
    pendingEmailAttempts: integer('pending_email_attempts'),
    ...timestamps,
  },
  (t) => [check('users_role_check', sql`${t.role} in ('user', 'admin')`)],
);

export const otps = pgTable(
  'otps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // One code per address: a new code replaces the old one.
    email: text('email').notNull().unique(),
    otp: text('otp').notNull(),
    // Expired rows are deleted on write and by `db:cleanup` (spec 023), as the TTL index did.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [index('otps_expires_at_idx').on(t.expiresAt)],
);

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  ...timestamps,
});

export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  ...timestamps,
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    price: money('price').notNull(),
    // Optional: the Mongoose schema never stored it, and products are created without one.
    sku: text('sku'),
    images: jsonb('images').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    stock: integer('stock').notNull().default(0),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    ...timestamps,
  },
  (t) => [
    check('products_price_check', sql`${t.price} >= 0`),
    check('products_stock_check', sql`${t.stock} >= 0`),
    index('products_category_idx').on(t.categoryId),
    index('products_brand_idx').on(t.brandId),
    index('products_sku_idx').on(t.sku),
    // Replaces the Mongo text index on name.
    index('products_name_search_idx').using('gin', sql`to_tsvector('english', ${t.name})`),
  ],
);

export const carts = pgTable('carts', {
  id: uuid('id').primaryKey().defaultRandom(),
  // One cart per user.
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  ...timestamps,
});

export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
    // Keeps the cart's item order stable, as the Mongo array did.
    position: integer('position').notNull().default(0),
  },
  (t) => [unique('cart_items_cart_product_unique').on(t.cartId, t.productId), check('cart_items_quantity_check', sql`${t.quantity} >= 1`)],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Kept when the customer deletes their account, as in Mongo, where the order stayed with no user.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    items: jsonb('items').$type<OrderItem[]>().notNull(),
    subtotal: money('subtotal').notNull(),
    tax: money('tax').notNull().default(0),
    shipping: money('shipping').notNull().default(0),
    total: money('total').notNull(),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('pending'),
    paymentStatus: text('payment_status', { enum: PAYMENT_STATUSES }).notNull().default('pending'),
    paymentMethod: text('payment_method', { enum: ['stripe', 'cod'] }).notNull().default('stripe'),
    // Unique when set: a redelivered Stripe webhook can't create a second order (spec 018).
    stripeSessionId: text('stripe_session_id').unique(),
    shippingAddress: jsonb('shipping_address').$type<ShippingAddress>().notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('orders_user_created_idx').on(t.userId, t.createdAt.desc()), index('orders_status_idx').on(t.status)],
);

export const pendingCheckouts = pgTable(
  'pending_checkouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stripeSessionId: text('stripe_session_id').notNull().unique(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    items: jsonb('items').$type<OrderItem[]>().notNull(),
    shippingAddress: jsonb('shipping_address').$type<ShippingAddress>().notNull(),
    subtotal: money('subtotal').notNull(),
    tax: money('tax').notNull().default(0),
    shipping: money('shipping').notNull().default(0),
    total: money('total').notNull(),
    cartHash: text('cart_hash'),
    checkoutUrl: text('checkout_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // 24 hours after creation, as the Mongo TTL was.
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [index('pending_checkouts_reuse_idx').on(t.userId, t.cartHash, t.createdAt.desc()), index('pending_checkouts_expires_at_idx').on(t.expiresAt)],
);

export const PENDING_UPLOAD_TTL_SECONDS = 3600;

export const pendingUploads = pgTable(
  'pending_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['avatar'] }).notNull(),
    data: bytea('data').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    originalName: text('original_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '1 hour'`),
  },
  (t) => [index('pending_uploads_user_idx').on(t.userId), index('pending_uploads_expires_at_idx').on(t.expiresAt)],
);
