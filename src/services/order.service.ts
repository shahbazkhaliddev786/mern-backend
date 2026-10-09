import { Order, Product, PendingCheckout } from '../models/index.js';
import { getCart, clearCart } from './cart.service.js';
import { computeOrderPricing } from './pricing.service.js';
import { stripeClient } from '../config/stripe.js';
import config from '../config/config.js';
import { 
  sendOrderConfirmationEmail 
} from '../utils/order.confirmation.email.js';
import logger from '../utils/logger.js';
import type { IOrder, IShippingAddress } from '../models/order.model.js';
import mongoose from 'mongoose';

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

// Takes the user id and address rather than the request, so the agent's
// place_order tool can wrap it directly (reconciliation.md Gap 1).
export const createCheckoutSession = async (userId: string, shippingAddress: IShippingAddress) => {
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
  await PendingCheckout.create({
    stripeSessionId: session.id,
    user: userId,
    items: cart.items.map((item: any) => ({
      product: item.product._id,
      name: item.product.name,
      price: item.product.price,
      quantity: item.quantity,
      image: item.product.images[0] || '',
    })),
    shippingAddress,
    subtotal: cart.subtotal,
    tax,
    shipping,
    total,
  });

  return { sessionId: session.id, url: session.url };
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
    const existingOrder = await Order.findOne({ stripeSessionId: session.id });
    if (existingOrder) {
      logger.info('Order already exists for completed session, skipping', { sessionId: session.id });
      return { received: true };
    }

    const pending = await PendingCheckout.findOne({ stripeSessionId: session.id });
    if (!pending) {
      logger.warn('No pending checkout found for completed session', { sessionId: session.id });
      return { received: true };
    }

    // Payment is confirmed — only now does the Order actually get created.
    let order: any = await Order.create({
      user: pending.user as any,
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
    });

    await PendingCheckout.deleteOne({ _id: pending._id });

    order = await order.populate({ path: 'user', select: 'name email _id' });

    // Safe user access — use any for populated user
    const populatedUser: any = order.user;

    // Clear cart
    const userId = session.metadata.userId;
    if (userId && userId !== 'guest') {
      await clearCart(userId);
    }

    // Send email if user has email
    if (populatedUser && populatedUser.email) {
      await sendOrderConfirmationEmail(populatedUser.email, order);
    }

    logger.info('Payment successful - Order created', {
      orderId: order._id,
      userId: populatedUser?._id || 'guest',
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
  const order = await Order.findById(orderId).populate('items.product');
  if (!order) throw new Error('Order not found');

  const oldStatus = order.status;

  // Only decrement stock when moving to dispatched or completed
  // and only if it hasn't been decremented before (i.e., was pending)
  if (
    (newStatus === 'shipped' || newStatus === 'delivered') &&
    oldStatus === 'pending'
  ) {
    // Use atomic update to safely decrement stock
    const bulkOps = order.items.map((item: any) => ({
      updateOne: {
        filter: { _id: item.product._id, stock: { $gte: item.quantity } },
        update: { $inc: { stock: -item.quantity } },
      },
    }));

    if (bulkOps.length > 0) {
      const result = await Product.bulkWrite(bulkOps);

      // Check if all products had enough stock
      const failedUpdates = bulkOps.length - (result.matchedCount || 0);
      if (failedUpdates > 0) {
        throw new Error('Insufficient stock for one or more products');
      }
    }
  }

  // Update order status
  order.status = newStatus;
  await order.save();

  logger.info('Order status updated with stock deduction', {
    orderId,
    oldStatus,
    newStatus,
    itemsDeducted: order.items.length,
  });

  return order;
};

export const deleteOrder = async (orderId: string) => {
  const order = await Order.findById(orderId);
  if (!order) throw new Error('Order not found');

  await Order.deleteOne({ _id: orderId });

  logger.info('Order deleted', { orderId });

  return { message: 'Order deleted successfully' };
};

export const getUserOrders = async (userId: string) => {
  return Order.find({ user: userId })
    .sort({ createdAt: -1 })
    .populate('items.product', 'name images price');
};

export const getMyOrders = async (userId: string): Promise<IOrder[]> => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new NotFoundError('Invalid user ID');
  }
  return await Order.find({ user: userId })
    .sort({ createdAt: -1 })
    .select('-__v')
    .lean();
};

export const getOrderById = async (orderId: string) => {
  const order = await Order.findById(orderId)
    .populate('user', 'name email')
    .populate('items.product', 'name images price');

  if (!order) throw new Error('Order not found');

  return order;
};