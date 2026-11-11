import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client.js';
import { cartItems, carts, products } from '../db/schema/index.js';
import { isId } from '../utils/ids.js';
import { cartProduct, productsById, type ApiCartProduct } from './shapes.js';

// Signed-in carts, keyed by userId. Nothing here takes an Express request, so the
// cart controllers and the agent's cart tools (which close over ctx.userId) share
// these functions. Guest carts live in the session — see guest-cart.service.ts.

type CartRow = typeof carts.$inferSelect;

export interface ApiCartItem {
  _id: string;
  product: ApiCartProduct | null;
  quantity: number;
}

// Calculate totals
export const calculateCartTotals = async (items: any[]): Promise<{ itemsCount: number; subtotal: number }> => {
  let itemsCount = 0;
  let subtotal = 0;

  const unpriced = items.filter((item) => typeof item.product === 'string').map((item) => item.product as string);
  const prices = await productsById(unpriced.filter(isId));

  for (const item of items) {
    const quantity = Number(item.quantity) || 0;
    itemsCount += quantity;

    let price = 0;
    if (typeof item.product === 'object' && item.product?.price !== undefined) {
      price = item.product.price;
    } else if (typeof item.product === 'string') {
      price = prices.get(item.product)?.price || 0;
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
  const [product] = isId(productId) ? await getDb().select().from(products).where(eq(products.id, productId)) : [];
  if (!product) throw new Error('Product not found');
  if (quantity > 0 && product.stock < quantity) throw new Error('Insufficient stock');
  return product;
};

/** The user's cart, created on first use. With `lock`, the row is held until the transaction ends. */
export const ensureCart = async (db: Executor, userId: string, lock = false): Promise<CartRow> => {
  if (!isId(userId)) throw new Error('User not found');
  await db.insert(carts).values({ userId }).onConflictDoNothing({ target: carts.userId });
  const query = db.select().from(carts).where(eq(carts.userId, userId));
  const [cart] = lock ? await query.for('update') : await query;
  return cart!;
};

export const findCart = async (db: Executor, userId: string, lock = false): Promise<CartRow | undefined> => {
  if (!isId(userId)) return undefined;
  const query = db.select().from(carts).where(eq(carts.userId, userId));
  const [cart] = lock ? await query.for('update') : await query;
  return cart;
};

/** Marks the cart as changed, as Mongoose's timestamps did on every save. */
export const touchCart = (db: Executor, cartId: string) => db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));

/** The cart's lines in the order they were added, each with its product (null once deleted). */
export const loadCartItems = async (cartId: string): Promise<ApiCartItem[]> => {
  const rows = await getDb().select().from(cartItems).where(eq(cartItems.cartId, cartId)).orderBy(asc(cartItems.position));
  const found = await productsById(rows.map((row) => row.productId));
  return rows.map((row) => {
    const product = found.get(row.productId);
    return { product: product ? cartProduct(product) : null, quantity: row.quantity, _id: row.id };
  });
};

/** Adds `quantity` to the product's line, or appends a new line at the end of the cart. */
export const addCartLine = async (db: Executor, cartId: string, productId: string, quantity: number) => {
  await db
    .insert(cartItems)
    .values({
      cartId,
      productId,
      quantity,
      position: sql`(SELECT coalesce(max(${cartItems.position}), -1) + 1 FROM ${cartItems} WHERE ${cartItems.cartId} = ${cartId})`,
    })
    .onConflictDoUpdate({
      target: [cartItems.cartId, cartItems.productId],
      set: { quantity: sql`${cartItems.quantity} + excluded.quantity` },
    });
};

/** Sets a line's quantity; 0 or less removes it. False when the product isn't in the cart. */
export const setCartLine = async (db: Executor, cartId: string, productId: string, quantity: number): Promise<boolean> => {
  const line = and(eq(cartItems.cartId, cartId), eq(cartItems.productId, productId));
  const changed =
    quantity <= 0
      ? await db.delete(cartItems).where(line).returning({ id: cartItems.id })
      : await db.update(cartItems).set({ quantity }).where(line).returning({ id: cartItems.id });
  return changed.length > 0;
};

export const getCart = async (userId: string): Promise<any> => {
  const cart = await ensureCart(getDb(), userId);
  const items = await loadCartItems(cart.id);
  const totals = await calculateCartTotals(items);

  return {
    _id: cart.id,
    user: cart.userId,
    items,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    itemsCount: totals.itemsCount,
    subtotal: totals.subtotal,
  };
};

export const addToCart = async (userId: string, productId: string, quantity: number = 1): Promise<any> => {
  const product = await findProductForQuantity(productId, quantity);

  // The cart row is locked while its line is read and written, so two adds at once can't both
  // pass the stock check on the same old quantity.
  await getDb().transaction(async (tx) => {
    const cart = await ensureCart(tx, userId, true);
    const [existing] = await tx
      .select({ quantity: cartItems.quantity })
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId)));

    // Final stock validation after merging with what's already in the cart
    const newQuantity = quantity + (existing?.quantity ?? 0);
    if (product.stock < newQuantity) {
      throw new Error('Not enough stock');
    }

    await addCartLine(tx, cart.id, productId, quantity);
    await touchCart(tx, cart.id);
  });

  return getCart(userId);
};

// A quantity of 0 removes the item — the agent's update_cart_item relies on this.
export const updateCartItem = async (userId: string, productId: string, quantity: number): Promise<any> => {
  await findProductForQuantity(productId, quantity);

  const cart = await findCart(getDb(), userId);
  if (!cart) throw new Error('Cart not found');

  if (!(await setCartLine(getDb(), cart.id, productId, quantity))) throw new Error('Item not in cart');
  await touchCart(getDb(), cart.id);

  return getCart(userId);
};

export const removeFromCart = async (userId: string, productId: string): Promise<any> => {
  const cart = await findCart(getDb(), userId);
  if (!cart) throw new Error('Cart not found');

  if (isId(productId)) {
    await getDb()
      .delete(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId)));
  }
  await touchCart(getDb(), cart.id);

  return getCart(userId);
};

/** Deletes every line of the user's cart, if they have one. Runs inside `db` when given a transaction. */
export const emptyCart = async (db: Executor, userId: string) => {
  const cart = await findCart(db, userId, true);
  if (!cart) return;
  await db.delete(cartItems).where(eq(cartItems.cartId, cart.id));
  await touchCart(db, cart.id);
};

export const clearCart = async (userId: string): Promise<any> => {
  await emptyCart(getDb(), userId);
  return getCart(userId);
};
