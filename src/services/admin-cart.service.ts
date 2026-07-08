import { Cart, Product, User } from '../models/index.js';
import { calculateCartTotals, CART_ITEM_POPULATE } from './cart.service.js';

const USER_POPULATE = { path: 'user', select: 'name email' };

export const getAllCartsService = async ({
  search,
  page = 1,
  limit = 20,
}: {
  search?: string;
  page?: number;
  limit?: number;
} = {}) => {
  const query: any = { items: { $exists: true, $ne: [] } };

  if (search && search.trim()) {
    const regex = new RegExp(search.trim(), 'i');
    const matchingUsers = await User.find({ $or: [{ name: regex }, { email: regex }] }).select('_id');
    query.user = { $in: matchingUsers.map((u) => u._id) };
  }

  const totalItems = await Cart.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const skip = (page - 1) * limit;

  const carts = await Cart.find(query)
    .populate(USER_POPULATE)
    .populate({ path: 'items.product', select: 'price' })
    .sort({ updatedAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const summaries = await Promise.all(
    carts.map(async (cart: any) => {
      const totals = await calculateCartTotals(cart.items);
      return {
        _id: cart._id,
        user: cart.user,
        itemsCount: totals.itemsCount,
        subtotal: totals.subtotal,
        updatedAt: cart.updatedAt,
      };
    })
  );

  return {
    carts: summaries,
    pagination: {
      currentPage: page,
      totalPages,
      totalItems,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
};

export const getCartByUserIdService = async (userId: string) => {
  const cart = await Cart.findOne({ user: userId }).populate([CART_ITEM_POPULATE, USER_POPULATE]);
  if (!cart) throw new Error('Cart not found for this user');

  const totals = await calculateCartTotals(cart.items);
  const cartData = cart.toObject();

  return {
    ...cartData,
    itemsCount: totals.itemsCount,
    subtotal: totals.subtotal,
  };
};

export const adminUpdateCartItemService = async (userId: string, productId: string, quantity: number) => {
  const product = await Product.findById(productId);
  if (!product) throw new Error('Product not found');
  if (quantity > 0 && product.stock < quantity) throw new Error('Insufficient stock');

  const cart: any = await Cart.findOne({ user: userId });
  if (!cart) throw new Error('Cart not found for this user');

  const itemIndex = cart.items.findIndex((item: any) => item.product.toString() === productId);
  if (itemIndex === -1) throw new Error('Item not in cart');

  if (quantity <= 0) {
    cart.items.splice(itemIndex, 1);
  } else {
    cart.items[itemIndex].quantity = quantity;
  }

  await cart.save();
  return getCartByUserIdService(userId);
};

export const adminRemoveCartItemService = async (userId: string, productId: string) => {
  const cart: any = await Cart.findOne({ user: userId });
  if (!cart) throw new Error('Cart not found for this user');

  cart.items = cart.items.filter((item: any) => item.product.toString() !== productId);
  await cart.save();
  return getCartByUserIdService(userId);
};

export const adminClearCartService = async (userId: string) => {
  const cart: any = await Cart.findOne({ user: userId });
  if (!cart) throw new Error('Cart not found for this user');

  cart.items = [];
  await cart.save();
  return getCartByUserIdService(userId);
};
