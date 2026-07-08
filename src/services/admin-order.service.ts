import { Types } from 'mongoose';
import { Order, Product, User } from '../models/index.js';
import { getOrderById } from './order.service.js';

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

  const subtotal = order.items.reduce((sum: number, item: any) => sum + item.price * item.quantity, 0);
  const tax = updates.tax !== undefined ? Number(updates.tax) : order.tax;
  const shipping = updates.shipping !== undefined ? Number(updates.shipping) : order.shipping;

  order.subtotal = subtotal;
  order.tax = tax;
  order.shipping = shipping;
  order.total = subtotal + tax + shipping;

  await order.save();

  return getOrderById(orderId);
};
