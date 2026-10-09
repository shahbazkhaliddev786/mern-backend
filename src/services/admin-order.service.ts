import { Types } from 'mongoose';
import { Order, Product, User } from '../models/index.js';
import { getOrderById } from './order.service.js';
import { computeOrderTotal } from './pricing.service.js';
import logger from '../utils/logger.js';

const USER_POPULATE = { path: 'user', select: 'name email' };

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
  const query: any = {};

  if (status) {
    query.status = status;
  }

  if (search && search.trim()) {
    const trimmed = search.trim();

    if (Types.ObjectId.isValid(trimmed)) {
      query._id = trimmed;
    } else {
      const regex = new RegExp(trimmed, 'i');
      const matchingUsers = await User.find({ $or: [{ name: regex }, { email: regex }] }).select('_id');
      query.user = { $in: matchingUsers.map((u) => u._id) };
    }
  }

  const totalItems = await Order.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const skip = (page - 1) * limit;

  const orders = await Order.find(query)
    .populate(USER_POPULATE)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const summaries = orders.map((order: any) => ({
    _id: order._id,
    user: order.user,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.total,
    itemsCount: order.items.length,
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
    city: string;
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
  const order: any = await Order.findById(orderId);
  if (!order) throw new Error('Order not found');

  if (updates.shippingAddress) {
    Object.assign(order.shippingAddress, updates.shippingAddress);
  }

  if (updates.items) {
    const existingByProduct = new Map(order.items.map((item: any) => [item.product.toString(), item]));

    const resolvedItems = await Promise.all(
      updates.items.map(async ({ product, quantity }) => {
        const existing: any = existingByProduct.get(product);

        if (existing) {
          return {
            product: existing.product,
            name: existing.name,
            price: existing.price,
            quantity,
            image: existing.image,
          };
        }

        const productDoc = await Product.findById(product);
        if (!productDoc) throw new Error(`Product not found: ${product}`);

        return {
          product: productDoc._id,
          name: productDoc.name,
          price: productDoc.price,
          quantity,
          image: productDoc.images?.[0] || '',
        };
      })
    );

    order.items = resolvedItems;
  }

  // Subtotal is always recomputed from the (server-resolved) line items.
  // tax/shipping are an explicit, validated admin override (the request
  // validation enforces non-negative numbers); when omitted they keep the
  // order's current values. The total formula + rounding come from the shared
  // pricing module so admin/customer/agent money all agree.
  const subtotal = order.items.reduce(
    (sum: number, item: any) => sum + item.price * item.quantity,
    0
  );
  const tax = updates.tax !== undefined ? Number(updates.tax) : order.tax;
  const shipping = updates.shipping !== undefined ? Number(updates.shipping) : order.shipping;

  const before = { subtotal: order.subtotal, tax: order.tax, shipping: order.shipping, total: order.total };
  const money = computeOrderTotal(subtotal, tax, shipping);

  order.subtotal = money.subtotal;
  order.tax = money.tax;
  order.shipping = money.shipping;
  order.total = money.total;

  // Validate only the paths this edit actually changed. A full-document
  // re-validation would reject legacy orders that have an incomplete
  // shippingAddress on file, blocking even a tax/shipping-only change.
  await order.save({ validateModifiedOnly: true });

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

  return getOrderById(orderId);
};
