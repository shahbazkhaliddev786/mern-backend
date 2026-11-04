import crypto from 'node:crypto';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb, isUniqueViolation } from '../db/client.js';
import { orders, pendingCheckouts, products, users, type OrderItem, type ShippingAddress } from '../db/schema/index.js';
import { emptyCart, getCart } from './cart.service.js';
import { computeOrderPricing } from './pricing.service.js';
import { apiOrder, productSummary, productsById, rawProduct, type ApiOrder, type ApiRefUser } from './shapes.js';
import { stripeClient } from '../config/stripe.js';
import config from '../config/config.js';
import { sendOrderConfirmationEmail } from '../utils/order.confirmation.email.js';
import { isId } from '../utils/ids.js';
import logger from '../utils/logger.js';

export class NotFoundError extends Error {
  status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

// Fingerprint of a cart and the address it ships to (spec 010): same items, quantities, prices
// and address → same hash. The price is part of it (spec 022), so a reused Stripe session never
// charges an old price. Sorted so item order doesn't matter; address fields trimmed and lowercased.
export const computeCartHash = (items: { product: unknown; quantity: number }[], shippingAddress: ShippingAddress): string => {
  const lines = items
    .map((item) => {
      const product = item.product as { _id?: unknown; price?: unknown } | string;
      const id = typeof product === 'object' && product?._id ? product._id : product;
      const price = typeof product === 'object' && product ? product.price : undefined;
      return `${String(id)}:${item.quantity}:${String(price ?? '')}`;
    })
    .sort();
  const address = (['fullName', 'address', 'apartment', 'city', 'state', 'postalCode', 'country', 'phone'] as const).map((field) =>
    String(shippingAddress[field] ?? '').trim().toLowerCase(),
  );
  return crypto.createHash('sha256').update(JSON.stringify({ lines, address })).digest('hex');
};

// Starts a Stripe checkout for the cart and records it as a pending checkout.
const startCheckout = async (userId: string, shippingAddress: ShippingAddress) => {
  const cart = await getCart(userId);
  if (cart.itemsCount === 0) throw new Error('Cart is empty');

  const lineItems = cart.items.map((item: any) => ({
    price_data: {
      currency: 'usd',
      product_data: {
        name: item.product.name,
        images: item.product.images.length > 0 ? [item.product.images[0]] : [],
      },
      unit_amount: Math.round(item.product.price * 100), // in cents
    },
    quantity: item.quantity,
  }));

  const session = await stripeClient.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: lineItems,
    mode: 'payment',
    success_url: `${config.FRONTEND_URL}/order/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.FRONTEND_URL}/cart`,
    metadata: {
      userId,
    },
  });

  // Only the shipping address comes from the caller (validated upstream with
  // shippingSchema). tax/shipping/total are computed server-side from the
  // cart — the client can never influence what's charged.
  const { tax, shipping, total } = computeOrderPricing(cart.subtotal);

  // Snapshot the cart against this checkout session — NOT an Order yet.
  // The Order is only created once the webhook confirms payment actually
  // succeeded (see handleStripeWebhook below), so a customer who abandons
  // or fails payment never ends up with an order on file.
  const items: OrderItem[] = cart.items.map((item: any) => ({
    _id: crypto.randomUUID(),
    product: item.product._id,
    name: item.product.name,
    price: item.product.price,
    quantity: item.quantity,
    image: item.product.images[0] || '',
  }));
  const [pending] = await getDb()
    .insert(pendingCheckouts)
    .values({
      stripeSessionId: session.id,
      userId,
      items,
      shippingAddress,
      subtotal: cart.subtotal,
      tax,
      shipping,
      total,
      cartHash: computeCartHash(cart.items, shippingAddress),
      checkoutUrl: session.url ?? null,
    })
    .returning({ id: pendingCheckouts.id });

  return { sessionId: session.id, url: session.url, pendingCheckoutId: pending!.id };
};

// Takes the user id and address rather than the request, so the agent's
// place_order tool can wrap it directly (reconciliation.md Gap 1).
export const createCheckoutSession = async (userId: string, shippingAddress: ShippingAddress) => {
  const { sessionId, url } = await startCheckout(userId, shippingAddress);
  return { sessionId, url };
};

// Stripe Checkout sessions live 24 h; reuse only well inside that window.
const CHECKOUT_REUSE_WINDOW_MS = 23 * 60 * 60 * 1000;

// The agent's checkout (spec 010): an open checkout for the same cart and address is reused,
// so asking twice never creates a second Stripe session. The /checkout page keeps calling
// createCheckoutSession directly.
export const createOrReuseCheckoutSession = async (userId: string, shippingAddress: ShippingAddress) => {
  const cart = await getCart(userId);
  if (cart.itemsCount === 0) throw new Error('Cart is empty');
  const { total } = computeOrderPricing(cart.subtotal);
  const cartHash = computeCartHash(cart.items, shippingAddress);

  const [open] = await getDb()
    .select({ id: pendingCheckouts.id, checkoutUrl: pendingCheckouts.checkoutUrl })
    .from(pendingCheckouts)
    .where(
      and(
        eq(pendingCheckouts.userId, userId),
        eq(pendingCheckouts.cartHash, cartHash),
        isNotNull(pendingCheckouts.checkoutUrl),
        gte(pendingCheckouts.createdAt, new Date(Date.now() - CHECKOUT_REUSE_WINDOW_MS)),
      ),
    )
    .orderBy(desc(pendingCheckouts.createdAt))
    .limit(1);
  if (open?.checkoutUrl) {
    return { pendingCheckoutId: open.id, url: open.checkoutUrl, reused: true, itemsCount: cart.itemsCount, total };
  }

  const { url, pendingCheckoutId } = await startCheckout(userId, shippingAddress);
  return { pendingCheckoutId, url, reused: false, itemsCount: cart.itemsCount, total };
};

export const handleStripeWebhook = async (rawBody: Buffer, sig: string | string[]) => {
  let event;

  try {
    event = stripeClient.webhooks.constructEvent(rawBody, sig as string, config.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as any;

    // Idempotency: Stripe can redeliver the same event. If an Order already
    // exists for this session, it's already been created below — don't
    // double-create.
    const [existingOrder] = await getDb().select({ id: orders.id }).from(orders).where(eq(orders.stripeSessionId, session.id));
    if (existingOrder) {
      logger.info('Order already exists for completed session, skipping', { sessionId: session.id });
      return { received: true };
    }

    const [pending] = await getDb().select().from(pendingCheckouts).where(eq(pendingCheckouts.stripeSessionId, session.id));
    if (!pending) {
      logger.warn('No pending checkout found for completed session', { sessionId: session.id });
      return { received: true };
    }

    // Payment is confirmed — only now does the Order actually get created. The order, the end of
    // the pending checkout and the emptied cart happen together or not at all.
    const userId = session.metadata?.userId;
    let created: typeof orders.$inferSelect;
    try {
      created = await getDb().transaction(async (tx) => {
        const [order] = await tx
          .insert(orders)
          .values({
            userId: pending.userId,
            items: pending.items,
            shippingAddress: pending.shippingAddress,
            subtotal: pending.subtotal,
            tax: pending.tax,
            shipping: pending.shipping,
            total: pending.total,
            stripeSessionId: session.id,
            status: 'pending',
            paymentStatus: 'paid',
            paidAt: new Date(),
          })
          .returning();
        await tx.delete(pendingCheckouts).where(eq(pendingCheckouts.id, pending.id));
        if (userId && userId !== 'guest') await emptyCart(tx, userId);
        return order!;
      });
    } catch (error) {
      // A delivery that arrived alongside this one created the order first (the unique session id).
      if (isUniqueViolation(error)) {
        logger.info('Order already exists for completed session, skipping', { sessionId: session.id });
        return { received: true };
      }
      throw error;
    }

    const [customer] = created.userId
      ? await getDb().select({ _id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, created.userId))
      : [];
    const order = apiOrder(created, { user: customer ?? null });

    // Send email if user has email
    if (customer?.email) {
      await sendOrderConfirmationEmail(customer.email, order);
    }

    logger.info('Payment successful - Order created', {
      orderId: order._id,
      userId: customer?._id || 'guest',
      amount: order.total,
      stripeSessionId: session.id,
    });
  }

  return { received: true };
};

// Updated updateOrderStatus with stock deduction
export const updateOrderStatus = async (
  orderId: string,
  newStatus: 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled'
) => {
  if (!isId(orderId)) throw new Error('Order not found');

  // The order row is locked, so two status changes at once can't both deduct stock, and the
  // deductions and the new status are saved together or not at all.
  const { order, oldStatus, bought } = await getDb().transaction(async (tx) => {
    const [found] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!found) throw new Error('Order not found');

    // The products as they were before any deduction, as Mongoose's populate returned them.
    const ids = [...new Set(found.items.map((item) => item.product))].filter(isId);
    const rows = ids.length ? await tx.select().from(products).where(inArray(products.id, ids)) : [];

    // Only decrement stock when moving to dispatched or completed
    // and only if it hasn't been decremented before (i.e., was pending)
    if ((newStatus === 'shipped' || newStatus === 'delivered') && found.status === 'pending') {
      let deducted = 0;
      for (const item of found.items) {
        if (!isId(item.product)) continue;
        const done = await tx
          .update(products)
          .set({ stock: sql`${products.stock} - ${item.quantity}` })
          .where(and(eq(products.id, item.product), gte(products.stock, item.quantity)))
          .returning({ id: products.id });
        deducted += done.length;
      }
      // Check if all products had enough stock
      if (deducted < found.items.length) {
        throw new Error('Insufficient stock for one or more products');
      }
    }

    const [updated] = await tx.update(orders).set({ status: newStatus }).where(eq(orders.id, orderId)).returning();
    return { order: updated!, oldStatus: found.status, bought: new Map(rows.map((row) => [row.id, rawProduct(row)])) };
  });

  logger.info('Order status updated with stock deduction', {
    orderId,
    oldStatus,
    newStatus,
    itemsDeducted: order.items.length,
  });

  return apiOrder(order, { product: (id) => bought.get(id) ?? null });
};

export const deleteOrder = async (orderId: string) => {
  const deleted = isId(orderId) ? await getDb().delete(orders).where(eq(orders.id, orderId)).returning({ id: orders.id }) : [];
  if (deleted.length === 0) throw new Error('Order not found');

  logger.info('Order deleted', { orderId });

  return { message: 'Order deleted successfully' };
};

/** Orders with each item's product as `{ _id, name, price, images }`, or null once deleted. */
const withProductSummaries = async (rows: (typeof orders.$inferSelect)[], user?: (row: typeof orders.$inferSelect) => ApiRefUser | null) => {
  const found = await productsById(rows.flatMap((row) => row.items.map((item) => item.product)).filter(isId));
  return rows.map((row) => apiOrder(row, { ...(user ? { user: user(row) } : {}), product: (id) => productSummary(found.get(id)) }));
};

export const getUserOrders = async (userId: string) => {
  if (!isId(userId)) return [];
  const rows = await getDb().select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt));
  return withProductSummaries(rows);
};

export const getMyOrders = async (userId: string): Promise<ApiOrder[]> => {
  if (!isId(userId)) {
    throw new NotFoundError('Invalid user ID');
  }
  const rows = await getDb().select().from(orders).where(eq(orders.userId, userId)).orderBy(desc(orders.createdAt));
  return rows.map((row) => apiOrder(row));
};

// Owner-scoped lookup for the agent's get_order_status: another user's order and a
// missing one both return null, so order ids can't be probed (security.md §4).
export const getMyOrderById = async (userId: string, orderId: string): Promise<ApiOrder | null> => {
  if (!isId(orderId) || !isId(userId)) return null;
  const [row] = await getDb()
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.userId, userId)));
  return row ? apiOrder(row) : null;
};

export const getOrderById = async (orderId: string) => {
  const [row] = isId(orderId) ? await getDb().select().from(orders).where(eq(orders.id, orderId)) : [];
  if (!row) throw new Error('Order not found');

  const [customer] = row.userId
    ? await getDb().select({ _id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, row.userId))
    : [];
  const [order] = await withProductSummaries([row], () => customer ?? null);
  return order!;
};
