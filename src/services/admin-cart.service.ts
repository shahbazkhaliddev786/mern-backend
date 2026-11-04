import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { cartItems, carts, products, users } from '../db/schema/index.js';
import { isId } from '../utils/ids.js';
import { calculateCartTotals, findCart, findProductForQuantity, loadCartItems, setCartLine, touchCart } from './cart.service.js';

const userRef = { _id: users.id, name: users.name, email: users.email };

// Each cart's item count and subtotal, for carts with at least one line.
const cartTotals = () =>
  getDb()
    .select({
      cartId: cartItems.cartId,
      itemsCount: sql<string>`sum(${cartItems.quantity})`.as('items_count'),
      subtotal: sql<string>`sum(${cartItems.quantity} * ${products.price})`.as('subtotal'),
    })
    .from(cartItems)
    .innerJoin(products, eq(cartItems.productId, products.id))
    .groupBy(cartItems.cartId)
    .as('totals');

export const getAllCartsService = async ({
  search,
  page = 1,
  limit = 20,
}: {
  search?: string;
  page?: number;
  limit?: number;
} = {}) => {
  const term = search?.trim();
  // A case-insensitive pattern on the customer's name or email, as the Mongo regex was.
  const where: SQL | undefined = term ? or(sql`${users.name} ~* ${term}`, sql`${users.email} ~* ${term}`) : undefined;
  const totals = cartTotals();

  const [counted] = await getDb()
    .select({ total: count() })
    .from(carts)
    .innerJoin(users, eq(carts.userId, users.id))
    .innerJoin(totals, eq(totals.cartId, carts.id))
    .where(where);
  const totalItems = counted?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const skip = (page - 1) * limit;

  const rows = await getDb()
    .select({ _id: carts.id, user: userRef, itemsCount: totals.itemsCount, subtotal: totals.subtotal, updatedAt: carts.updatedAt })
    .from(carts)
    .innerJoin(users, eq(carts.userId, users.id))
    .innerJoin(totals, eq(totals.cartId, carts.id))
    .where(where)
    .orderBy(desc(carts.updatedAt), desc(carts.id))
    .limit(limit)
    .offset(skip);

  return {
    carts: rows.map((row) => ({ ...row, itemsCount: Number(row.itemsCount), subtotal: Number(Number(row.subtotal).toFixed(2)) })),
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
  const cart = await findCart(getDb(), userId);
  if (!cart) throw new Error('Cart not found for this user');

  const [user] = await getDb().select(userRef).from(users).where(eq(users.id, cart.userId));
  const items = await loadCartItems(cart.id);
  const totals = await calculateCartTotals(items);

  return {
    _id: cart.id,
    user: user ?? null,
    items,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
    itemsCount: totals.itemsCount,
    subtotal: totals.subtotal,
  };
};

export const adminUpdateCartItemService = async (userId: string, productId: string, quantity: number) => {
  await findProductForQuantity(productId, quantity);

  const cart = await findCart(getDb(), userId);
  if (!cart) throw new Error('Cart not found for this user');

  if (!(await setCartLine(getDb(), cart.id, productId, quantity))) throw new Error('Item not in cart');
  await touchCart(getDb(), cart.id);

  return getCartByUserIdService(userId);
};

export const adminRemoveCartItemService = async (userId: string, productId: string) => {
  const cart = await findCart(getDb(), userId);
  if (!cart) throw new Error('Cart not found for this user');

  if (isId(productId)) {
    await getDb()
      .delete(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId)));
  }
  await touchCart(getDb(), cart.id);
  return getCartByUserIdService(userId);
};

export const adminClearCartService = async (userId: string) => {
  const cart = await findCart(getDb(), userId);
  if (!cart) throw new Error('Cart not found for this user');

  await getDb().delete(cartItems).where(eq(cartItems.cartId, cart.id));
  await touchCart(getDb(), cart.id);
  return getCartByUserIdService(userId);
};
