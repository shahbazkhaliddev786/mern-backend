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

// Helper for session cart 
const getSessionCart = (req: Request): SessionCart => {
  console.log('[SESSION] Accessing session:', req.session);

  const session = req.session as any;
  if (!session) {
    console.error('[SESSION] req.session is undefined! Session middleware missing?');
    return { items: [] };
  }

  if (!session.cart) {
    console.log('[SESSION] Creating new empty cart in session');
    session.cart = { items: [] };
  }

  console.log('[SESSION] Returning cart:', session.cart);
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
  // ─── Common validation ───────────────────────────────────────
  const product = await Product.findById(productId);
  if (!product) throw new Error('Product not found');

  // Early check for initial quantity
  if (product.stock < quantity) {
    throw new Error('Insufficient stock');
  }

  const user = (req as any).user;

  // ─── Logged-in user path ─────────────────────────────────────
  if (user) {
    let cart = await Cart.findOne({ user: user._id });
    if (!cart) {
      cart = await Cart.create({ user: user._id, items: [] });
    }

    const itemIndex = cart.items.findIndex(
      (item) => item.product.toString() === productId
    );

    // Calculate final quantity if item already exists
    let newQuantity = quantity;
    if (itemIndex !== -1) {
      newQuantity += cart.items[itemIndex]!.quantity;
    }

    // Final stock validation after merge
    if (product.stock < newQuantity) {
      throw new Error('Not enough stock');
    }

    // Update existing or add new
    if (itemIndex !== -1) {
      // Safe: we already checked itemIndex !== -1
      cart.items[itemIndex]!.quantity = newQuantity;
    } else {
      // Convert string ID → ObjectId (required by schema)
      cart.items.push({
        product: new Types.ObjectId(productId),
        quantity,
      });
    }

    await cart.save();
    return getCart(req);
  }

  // ─── Guest path ──────────────────────────────────────────────
  const sessionCart = getSessionCart(req);

  const itemIndex = sessionCart.items.findIndex(
    (item) => item.product === productId
  );

  let newQuantity = quantity;
  if (itemIndex !== -1) {
    newQuantity += sessionCart.items[itemIndex]!.quantity;
  }

  if (product.stock < newQuantity) {
    throw new Error('Not enough stock');
  }

  if (itemIndex !== -1) {
    sessionCart.items[itemIndex]!.quantity = newQuantity;
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
  const user = (req as any).user;
  if (!user) {
    console.log('[MERGE] No user found → skipping merge');
    return;
  }

  console.log('[MERGE] Starting merge for user:', user._id.toString());

  const sessionCart = getSessionCart(req);
  console.log('[MERGE] Raw session cart:', JSON.stringify(req.session, null, 2));

  if (!sessionCart?.items?.length) {
    console.log('[MERGE] No items in session cart → nothing to merge');
    return;
  }

  console.log('[MERGE] Guest items to merge:', JSON.stringify(sessionCart.items, null, 2));

  let dbCart = await Cart.findOne({ user: user._id });
  console.log('[MERGE] DB cart before merge:', dbCart ? dbCart.toObject() : 'No DB cart found');

  if (!dbCart) {
    console.log('[MERGE] Creating new DB cart');
    dbCart = await Cart.create({ user: user._id, items: [] });
  }

  for (const guestItem of sessionCart.items) {
    console.log('[MERGE] Processing guest item:', guestItem);

    const productIdStr = guestItem.product.toString();
    const existingIndex = dbCart.items.findIndex(
      (item: any) => item.product.toString() === productIdStr
    );

    if (existingIndex !== -1) {
      console.log(`[MERGE] Updating existing item at index ${existingIndex}`);
      dbCart.items[existingIndex]!.quantity += guestItem.quantity;
    } else {
      console.log('[MERGE] Adding new item to DB cart');
      dbCart.items.push({
        product: new Types.ObjectId(guestItem.product),
        quantity: guestItem.quantity,
      });
    }
  }

  console.log('[MERGE] DB cart after updates (before save):', dbCart.toObject());

  try {
    await dbCart.save();
    console.log('[MERGE] DB cart saved successfully');
  } catch (saveError) {
    console.error('[MERGE] Failed to save DB cart:', saveError);
    throw saveError; // let it bubble up so we can see it in logs
  }

  // Clear session cart
  req.session.cart = { items: [] };
  console.log('[MERGE] Session cart cleared');

  // Optional: force session save (sometimes needed)
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        console.error('[MERGE] Failed to save session:', err);
        reject(err);
      } else {
        console.log('[MERGE] Session saved');
        resolve();
      }
    });
  });
};