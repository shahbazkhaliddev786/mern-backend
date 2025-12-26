import type { Request } from 'express';
import { Order, Product } from '../models/index.js';
import { getCart, clearCart } from './cart.service.js';
import { stripeClient } from '../config/stripe.js';
import config from '../config/config.js';
import { 
  sendOrderConfirmationEmail 
} from '../utils/order.confirmation.email.js';
import logger from '../utils/logger.js';

export const createCheckoutSession = async (req: Request) => {
  const cart = await getCart(req);
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
      userId: (req as any).user?._id?.toString() || 'guest',
    },
  });

  // Create pending order
  await Order.create({
    user: (req as any).user?._id || null,
    items: cart.items.map((item: any) => ({
      product: item.product._id,
      name: item.product.name,
      price: item.product.price,
      quantity: item.quantity,
      image: item.product.images[0] || '',
    })),
    subtotal: cart.subtotal,
    tax: 0,
    shipping: 0,
    total: cart.subtotal,
    stripeSessionId: session.id,
    status: 'pending',
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

    // Find and update order
    const order = await Order.findOneAndUpdate(
      { stripeSessionId: session.id },
      { status: 'pending' },
      { new: true }
    ).populate({
      path: 'user',
      select: 'name email _id',
    });

    // Guard against null
    if (!order) {
      logger.warn('Order not found for completed session', { sessionId: session.id });
      return { received: true };
    }

    // Safe user access — use any for populated user
    const populatedUser: any = order.user;

    // Clear cart
    const userId = session.metadata.userId;
    if (userId && userId !== 'guest') {
      await clearCart({ user: { _id: userId } } as any);
    }

    // Send email if user has email
    if (populatedUser && populatedUser.email) {
      await sendOrderConfirmationEmail(populatedUser.email, order);
    }

    logger.info('Payment successful - Order processed', {
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
  newStatus: 'pending' | 'dispatched' | 'completed'
) => {
  const order = await Order.findById(orderId).populate('items.product');
  if (!order) throw new Error('Order not found');

  const oldStatus = order.status;

  // Only decrement stock when moving to dispatched or completed
  // and only if it hasn't been decremented before (i.e., was pending)
  if (
    (newStatus === 'dispatched' || newStatus === 'completed') &&
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

export const getOrderById = async (orderId: string) => {
  const order = await Order.findById(orderId)
    .populate('user', 'name email')
    .populate('items.product', 'name images price');

  if (!order) throw new Error('Order not found');

  return order;
};