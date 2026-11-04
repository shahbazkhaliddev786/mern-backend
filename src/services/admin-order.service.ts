import crypto from 'node:crypto';
import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { orders, products, users, type OrderItem } from '../db/schema/index.js';
import { getOrderById } from './order.service.js';
import { computeOrderTotal } from './pricing.service.js';
import { isId } from '../utils/ids.js';
import logger from '../utils/logger.js';

export const getAllOrdersService = async ({
  search,
  status,
  page = 1,
  limit = 20,
}: {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
} = {}) => {
  const conditions: SQL[] = [];

  if (status) {
    conditions.push(sql`${orders.status} = ${status}`);
  }

  const trimmed = search?.trim();
  if (trimmed) {
    // An order id finds that order; anything else is a case-insensitive pattern on the customer.
    conditions.push(isId(trimmed) ? eq(orders.id, trimmed) : or(sql`${users.name} ~* ${trimmed}`, sql`${users.email} ~* ${trimmed}`)!);
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const [counted] = await getDb().select({ total: count() }).from(orders).leftJoin(users, eq(orders.userId, users.id)).where(where);
  const totalItems = counted?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const skip = (page - 1) * limit;

  const rows = await getDb()
    .select({
      _id: orders.id,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      total: orders.total,
      itemsCount: sql<number>`jsonb_array_length(${orders.items})`.mapWith(Number),
      createdAt: orders.createdAt,
    })
    .from(orders)
    .leftJoin(users, eq(orders.userId, users.id))
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit)
    .offset(skip);

  const summaries = rows.map(({ userId, userName, userEmail, ...order }) => ({
    _id: order._id,
    user: userId ? { _id: userId, name: userName!, email: userEmail! } : null,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.total,
    itemsCount: order.itemsCount,
    createdAt: order.createdAt,
  }));

  return {
    orders: summaries,
    pagination: {
      currentPage: page,
      totalPages,
      totalItems,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
};

interface AdminOrderItemInput {
  product: string;
  quantity: number;
}

interface AdminUpdateOrderDetailsInput {
  shippingAddress?: Partial<{
    fullName: string;
    address: string;
    apartment: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone: string;
  }>;
  tax?: number;
  shipping?: number;
  items?: AdminOrderItemInput[];
}

// Full order-details edit: shipping address, tax/shipping, and/or the item list.
// Deliberately does NOT touch Product.stock — stock deduction stays solely tied to
// the status-transition logic in updateOrderStatus (see order.service.ts).
export const adminUpdateOrderDetailsService = async (
  orderId: string,
  updates: AdminUpdateOrderDetailsInput
) => {
  if (!isId(orderId)) throw new Error('Order not found');

  // The order row is locked while it's read and rewritten, so two edits at once can't lose one.
  await getDb().transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw new Error('Order not found');

    const shippingAddress = updates.shippingAddress ? { ...order.shippingAddress, ...updates.shippingAddress } : order.shippingAddress;

    let items: OrderItem[] = order.items;
    if (updates.items) {
      const existingByProduct = new Map(order.items.map((item) => [item.product, item]));

      // Each line gets a new `_id`, as Mongoose gave the replaced subdocuments.
      items = await Promise.all(
        updates.items.map(async ({ product, quantity }) => {
          const existing = existingByProduct.get(product);

          if (existing) {
            return {
              _id: crypto.randomUUID(),
              product: existing.product,
              name: existing.name,
              price: existing.price,
              quantity,
              image: existing.image ?? '',
            };
          }

          const [productRow] = isId(product) ? await tx.select().from(products).where(eq(products.id, product)) : [];
          if (!productRow) throw new Error(`Product not found: ${product}`);

          return {
            _id: crypto.randomUUID(),
            product: productRow.id,
            name: productRow.name,
            price: productRow.price,
            quantity,
            image: productRow.images[0] || '',
          };
        })
      );
    }

    // Subtotal is always recomputed from the (server-resolved) line items.
    // tax/shipping are an explicit, validated admin override (the request
    // validation enforces non-negative numbers); when omitted they keep the
    // order's current values. The total formula + rounding come from the shared
    // pricing module so admin/customer/agent money all agree.
    const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const tax = updates.tax !== undefined ? Number(updates.tax) : order.tax;
    const shipping = updates.shipping !== undefined ? Number(updates.shipping) : order.shipping;

    const before = { subtotal: order.subtotal, tax: order.tax, shipping: order.shipping, total: order.total };
    const money = computeOrderTotal(subtotal, tax, shipping);

    // Only the fields this edit changes are written, so a legacy order with an incomplete
    // shippingAddress on file can still take a tax/shipping-only change.
    await tx
      .update(orders)
      .set({ shippingAddress, items, subtotal: money.subtotal, tax: money.tax, shipping: money.shipping, total: money.total })
      .where(eq(orders.id, orderId));

    // Audit: admin edits to order money are security-relevant write actions
    // (observability.md §4). Flat scalar meta (matches the codebase's logging
    // pattern) so the before/after totals are traceable.
    logger.info('ADMIN_ORDER_DETAILS_UPDATED', {
      orderId,
      taxOverridden: updates.tax !== undefined,
      shippingOverridden: updates.shipping !== undefined,
      itemsReplaced: updates.items !== undefined,
      subtotalBefore: before.subtotal,
      subtotalAfter: money.subtotal,
      taxBefore: before.tax,
      taxAfter: money.tax,
      shippingBefore: before.shipping,
      shippingAfter: money.shipping,
      totalBefore: before.total,
      totalAfter: money.total,
    });
  });

  return getOrderById(orderId);
};
