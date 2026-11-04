import type { Session, SessionData } from 'express-session';
import { getDb } from '../db/client.js';
import { addCartLine, calculateCartTotals, ensureCart, findProductForQuantity, touchCart } from './cart.service.js';
import { cartProduct, productsById } from './shapes.js';
import { isId } from '../utils/ids.js';

// Guest carts live in the express-session, so only the HTTP layer uses these —
// the agent requires sign-in (reconciliation.md Gap 16) and uses cart.service.ts.

type GuestSession = Session & Partial<SessionData>;

interface GuestCartItem {
  product: string;
  quantity: number;
}

// Returns the session's cart, creating an empty one on first use.
const getSessionCart = (session: GuestSession): { items: GuestCartItem[] } => {
  if (!session.cart) {
    session.cart = { items: [] };
  }
  return session.cart;
};

// Guest (session) cart items are only ever stored as { product: <id>, quantity }.
// Populate them with the same product fields the DB-backed cart returns, so
// every cart UI (which expects a full Product on item.product) works identically
// for guests and logged-in users.
const populateGuestCartItems = async (items: GuestCartItem[]): Promise<any[]> => {
  if (items.length === 0) return [];

  const found = await productsById(items.map((item) => item.product).filter(isId));

  return items
    .filter((item) => found.has(item.product))
    .map((item) => ({
      _id: item.product,
      product: cartProduct(found.get(item.product)!),
      quantity: item.quantity,
    }));
};

export const getGuestCart = async (session: GuestSession): Promise<any> => {
  const sessionCart = getSessionCart(session);
  const items = await populateGuestCartItems(sessionCart.items || []);
  const totals = await calculateCartTotals(items);

  return {
    ...sessionCart,
    items,
    itemsCount: totals.itemsCount,
    subtotal: totals.subtotal,
  };
};

export const addToGuestCart = async (session: GuestSession, productId: string, quantity: number = 1): Promise<any> => {
  const product = await findProductForQuantity(productId, quantity);
  const sessionCart = getSessionCart(session);

  const itemIndex = sessionCart.items.findIndex((item) => item.product === productId);

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

  return getGuestCart(session);
};

export const updateGuestCartItem = async (session: GuestSession, productId: string, quantity: number): Promise<any> => {
  await findProductForQuantity(productId, quantity);
  const sessionCart = getSessionCart(session);

  const itemIndex = sessionCart.items.findIndex((item) => item.product === productId);
  if (itemIndex === -1) throw new Error('Item not in cart');

  if (quantity <= 0) {
    sessionCart.items.splice(itemIndex, 1);
  } else {
    sessionCart.items[itemIndex]!.quantity = quantity;
  }

  return getGuestCart(session);
};

export const removeFromGuestCart = async (session: GuestSession, productId: string): Promise<any> => {
  const sessionCart = getSessionCart(session);
  sessionCart.items = sessionCart.items.filter((item) => item.product !== productId);
  return getGuestCart(session);
};

export const clearGuestCart = async (session: GuestSession): Promise<any> => {
  getSessionCart(session).items = [];
  return getGuestCart(session);
};

// After sign-in, moves the guest's session cart into their account cart and
// empties the session cart.
export const mergeGuestCartOnLogin = async (userId: string, session: GuestSession): Promise<void> => {
  const sessionCart = getSessionCart(session);
  if (!sessionCart.items.length) return;

  // Products deleted since they were added are left behind; the rest add to the account cart.
  const found = await productsById(sessionCart.items.map((item) => item.product).filter(isId));
  await getDb().transaction(async (tx) => {
    const dbCart = await ensureCart(tx, userId, true);
    for (const guestItem of sessionCart.items) {
      if (found.has(guestItem.product)) await addCartLine(tx, dbCart.id, guestItem.product, guestItem.quantity);
    }
    await touchCart(tx, dbCart.id);
  });

  session.cart = { items: [] };
  await new Promise<void>((resolve, reject) => {
    session.save((err) => (err ? reject(err) : resolve()));
  });
};
