import { Cart, Product } from '../models/index.js';
import { Types } from 'mongoose';

// Signed-in carts, keyed by userId. Nothing here takes an Express request, so the
// cart controllers and the agent's cart tools (which close over ctx.userId) share
// these functions. Guest carts live in the session — see guest-cart.service.ts.

// Shared populate spec for a cart's items — reused by admin-cart.service.ts
export const CART_ITEM_POPULATE = {
  path: 'items.product',
  select: 'name price images stock',
  populate: [
    { path: 'category', select: 'name' },
    { path: 'brand', select: 'name' },
  ],
};

// Calculate totals
export const calculateCartTotals = async (items: any[]): Promise<{ itemsCount: number; subtotal: number }> => {
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

// Loads the product being added or updated and checks the requested quantity
// against its stock. Shared by signed-in and guest carts.
export const findProductForQuantity = async (productId: string, quantity: number) => {
  const product = await Product.findById(productId);
  if (!product) throw new Error('Product not found');
  if (quantity > 0 && product.stock < quantity) throw new Error('Insufficient stock');
  return product;
};

export const getCart = async (userId: string): Promise<any> => {
  let cart: any = await Cart.findOne({ user: userId }).populate(CART_ITEM_POPULATE);

  if (!cart) {
    cart = await Cart.create({ user: userId, items: [] });
  }

  const items = cart.items || [];
  const totals = await calculateCartTotals(items);

  return {
    ...cart.toObject(),
    items,
    itemsCount: totals.itemsCount,
    subtotal: totals.subtotal,
  };
};

export const addToCart = async (userId: string, productId: string, quantity: number = 1): Promise<any> => {
  const product = await findProductForQuantity(productId, quantity);

  let cart = await Cart.findOne({ user: userId });
  if (!cart) {
    cart = await Cart.create({ user: userId, items: [] });
  }

  const itemIndex = cart.items.findIndex((item) => item.product.toString() === productId);

  // Final stock validation after merging with what's already in the cart
  let newQuantity = quantity;
  if (itemIndex !== -1) {
    newQuantity += cart.items[itemIndex]!.quantity;
  }
  if (product.stock < newQuantity) {
    throw new Error('Not enough stock');
  }

  if (itemIndex !== -1) {
    cart.items[itemIndex]!.quantity = newQuantity;
  } else {
    cart.items.push({ product: new Types.ObjectId(productId), quantity });
  }

  await cart.save();
  return getCart(userId);
};

// A quantity of 0 removes the item — the agent's update_cart_item relies on this.
export const updateCartItem = async (userId: string, productId: string, quantity: number): Promise<any> => {
  await findProductForQuantity(productId, quantity);

  const cart: any = await Cart.findOne({ user: userId });
  if (!cart) throw new Error('Cart not found');

  const itemIndex = cart.items.findIndex((item: any) => item.product.toString() === productId);
  if (itemIndex === -1) throw new Error('Item not in cart');

  if (quantity <= 0) {
    cart.items.splice(itemIndex, 1);
  } else {
    cart.items[itemIndex].quantity = quantity;
  }

  await cart.save();
  return getCart(userId);
};

export const removeFromCart = async (userId: string, productId: string): Promise<any> => {
  const cart: any = await Cart.findOne({ user: userId });
  if (!cart) throw new Error('Cart not found');

  cart.items = cart.items.filter((item: any) => item.product.toString() !== productId);

  await cart.save();
  return getCart(userId);
};

export const clearCart = async (userId: string): Promise<any> => {
  const cart: any = await Cart.findOne({ user: userId });
  if (cart) {
    cart.items = [];
    await cart.save();
  }
  return getCart(userId);
};
