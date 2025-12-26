import type { Request } from 'express';
import { Cart, Product } from '../models/index.js';
import { Types } from 'mongoose';

interface CartItem {
  product: string;
  quantity: number;
}

interface SessionCart {
  items: CartItem[];
}

// Helper for session cart — safe with any
const getSessionCart = (req: Request): SessionCart => {
  const session: any = req.session;
  if (!session.cart) {
    session.cart = { items: [] };
  }
  return session.cart;
};

// Calculate totals
const calculateCartTotals = async (items: any[]): Promise<{ itemsCount: number; subtotal: number }> => {
  let itemsCount = 0;
  let subtotal = 0;

  for (const item of items) {
    const quantity = Number(item.quantity) || 0;
    itemsCount += quantity;

    let price = 0;
    if (typeof item.product === 'object' && item.product?.price !== undefined) {
      price = item.product.price;
    } else if (typeof item.product === 'string') {
      const product = await Product.findById(item.product).select('price');
      price = product?.price || 0;
    }

    subtotal += price * quantity;
  }

  return {
    itemsCount,
    subtotal: Number(subtotal.toFixed(2)),
  };
};

export const getCart = async (req: Request): Promise<any> => {
  let rawCart: any;
  let items: any[] = [];

  const user: any = (req as any).user;

  if (user) {
    rawCart = await Cart.findOne({ user: user._id }).populate({
      path: 'items.product',
      select: 'name price images stock',
      populate: [
        { path: 'category', select: 'name' },
        { path: 'brand', select: 'name' },
      ],
    });

    if (!rawCart) {
      rawCart = await Cart.create({ user: user._id, items: [] });
    }

    items = rawCart.items || [];
  } else {
    rawCart = getSessionCart(req);
    items = rawCart.items || [];
  }

  const totals = await calculateCartTotals(items);

  const cartData = rawCart.toObject ? rawCart.toObject() : rawCart;

  return {
    ...cartData,
    itemsCount: totals.itemsCount,
    subtotal: totals.subtotal,
  };
};

export const addToCart = async (
  req: Request,
  productId: string,
  quantity: number = 1
): Promise<any> => {
  const product = await Product.findById(productId);
  if (!product) throw new Error('Product not found');
  if (product.stock < quantity) throw new Error('Insufficient stock');

  const user: any = (req as any).user;

  if (user) {
    let cart: any = await Cart.findOne({ user: user._id });
    if (!cart) {
      cart = await Cart.create({ user: user._id, items: [] });
    }

    const itemIndex = cart.items.findIndex(
      (item: any) => item.product.toString() === productId
    );

    let newQuantity = quantity;
    if (itemIndex > -1) {
      newQuantity += cart.items[itemIndex].quantity;
    }

    if (product.stock < newQuantity) {
      throw new Error('Not enough stock');
    }

    if (itemIndex > -1) {
      cart.items[itemIndex].quantity = newQuantity;
    } else {
      cart.items.push({ product: productId, quantity });
    }

    await cart.save();
    return getCart(req);
  }

  const sessionCart: any = getSessionCart(req);
  const itemIndex = sessionCart.items.findIndex(
    (item: any) => item.product === productId
  );

  let newQuantity = quantity;
  if (itemIndex > -1) {
    newQuantity += sessionCart.items[itemIndex].quantity;
  }

  if (product.stock < newQuantity) {
    throw new Error('Not enough stock');
  }

  if (itemIndex > -1) {
    sessionCart.items[itemIndex].quantity = newQuantity;
  } else {
    sessionCart.items.push({ product: productId, quantity });
  }

  return getCart(req);
};

export const updateCartItem = async (
  req: Request,
  productId: string,
  quantity: number
): Promise<any> => {
  const product = await Product.findById(productId);
  if (!product) throw new Error('Product not found');
  if (quantity > 0 && product.stock < quantity) throw new Error('Insufficient stock');

  const user: any = (req as any).user;

  if (user) {
    let cart: any = await Cart.findOne({ user: user._id });
    if (!cart) throw new Error('Cart not found');

    const itemIndex = cart.items.findIndex(
      (item: any) => item.product.toString() === productId
    );

    if (itemIndex === -1) throw new Error('Item not in cart');

    if (quantity <= 0) {
      cart.items.splice(itemIndex, 1);
    } else {
      cart.items[itemIndex].quantity = quantity;
    }

    await cart.save();
    return getCart(req);
  }

  const sessionCart: any = getSessionCart(req);
  const itemIndex = sessionCart.items.findIndex(
    (item: any) => item.product === productId
  );

  if (itemIndex === -1) throw new Error('Item not in cart');

  if (quantity <= 0) {
    sessionCart.items.splice(itemIndex, 1);
  } else {
    sessionCart.items[itemIndex].quantity = quantity;
  }

  return getCart(req);
};

export const removeFromCart = async (
  req: Request,
  productId: string
): Promise<any> => {
  const user: any = (req as any).user;

  if (user) {
    let cart: any = await Cart.findOne({ user: user._id });
    if (!cart) throw new Error('Cart not found');

    cart.items = cart.items.filter(
      (item: any) => item.product.toString() !== productId
    );

    await cart.save();
    return getCart(req);
  }

  const sessionCart: any = getSessionCart(req);
  sessionCart.items = sessionCart.items.filter(
    (item: any) => item.product !== productId
  );

  return getCart(req);
};

export const clearCart = async (req: Request): Promise<any> => {
  const user: any = (req as any).user;

  if (user) {
    let cart: any = await Cart.findOne({ user: user._id });
    if (cart) {
      cart.items = [];
      await cart.save();
    }
    return getCart(req);
  }

  const sessionCart: any = getSessionCart(req);
  sessionCart.items = [];

  return getCart(req);
};

export const mergeGuestCartOnLogin = async (req: Request): Promise<void> => {
  const user: any = (req as any).user;
  if (!user) return;

  const userId = user._id;
  const sessionCart: any = getSessionCart(req);

  if (!sessionCart.items || sessionCart.items.length === 0) {
    return;
  }

  let dbCart: any = await Cart.findOne({ user: userId });

  if (!dbCart) {
    dbCart = await Cart.create({ user: userId, items: [] });
  }

  for (const guestItem of sessionCart.items) {
    const existingItemIndex = dbCart.items.findIndex(
      (item: any) => item.product.toString() === guestItem.product
    );

    if (existingItemIndex > -1) {
      dbCart.items[existingItemIndex].quantity += guestItem.quantity;
    } else {
      dbCart.items.push({
        product: new Types.ObjectId(guestItem.product),
        quantity: guestItem.quantity,
      });
    }
  }

  await dbCart.save();

  (req.session as any).cart = { items: [] };
};