// The cart services against Postgres (spec 023): the behaviour the Mongo version had, plus the
// stock check holding when two adds for the same cart arrive at once.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { brands, carts, categories, products, users } from '../db/schema/index';
import { createTestDatabase, holdLocks, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import { addToCart, clearCart, getCart, removeFromCart, updateCartItem } from './cart.service';
import { addToGuestCart, clearGuestCart, mergeGuestCartOnLogin, updateGuestCartItem } from './guest-cart.service';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

const UNKNOWN = '00000000-0000-4000-8000-0000000000ff';

// [productId, quantity] per cart line, in order.
const lines = (cart: { items: { product: { _id: string } | null; quantity: number }[] }) =>
  cart.items.map((item) => [item.product?._id ?? null, item.quantity]);

describe.skipIf(!TEST_DATABASE_URL)('carts on Postgres', () => {
  let testDb: TestDatabase;
  let USER = '';
  let SHIRT = '';
  let MUG = '';

  beforeAll(async () => {
    testDb = await createTestDatabase('cart');
    const db = getDb();
    const [category] = await db.insert(categories).values({ name: 'Home' }).returning();
    const [brand] = await db.insert(brands).values({ name: 'Aljo' }).returning();
    const made = await db
      .insert(products)
      .values([
        { name: 'Linen Shirt', description: 'A shirt.', price: 40, stock: 5, categoryId: category!.id, brandId: brand!.id },
        { name: 'Clay Mug', description: 'A mug.', price: 12.5, stock: 10, categoryId: category!.id, brandId: brand!.id },
      ])
      .returning();
    SHIRT = made[0]!.id;
    MUG = made[1]!.id;
    const [user] = await db.insert(users).values({ name: 'Alice', email: 'alice.cart@example.com', password: 'hash' }).returning();
    USER = user!.id;
  }, 60_000);

  beforeEach(async () => {
    await getDb().delete(carts);
    await getDb().update(products).set({ stock: 5 }).where(eq(products.id, SHIRT));
    await getDb().update(products).set({ stock: 10 }).where(eq(products.id, MUG));
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  describe('signed-in cart (keyed by userId)', () => {
    it('creates an empty cart on first read', async () => {
      expect(await getCart(USER)).toMatchObject({ itemsCount: 0, subtotal: 0, user: USER });
      expect(await getDb().select().from(carts).where(eq(carts.userId, USER))).toHaveLength(1);
    });

    it('merges repeat adds and totals from product prices', async () => {
      await addToCart(USER, SHIRT, 2);
      const cart = await addToCart(USER, SHIRT, 1);

      expect(lines(cart)).toEqual([[SHIRT, 3]]);
      expect(cart).toMatchObject({ itemsCount: 3, subtotal: 120 });
    });

    it('enforces stock, including after merging, and rejects unknown products', async () => {
      await expect(addToCart(USER, SHIRT, 6)).rejects.toThrow('Insufficient stock');
      await addToCart(USER, SHIRT, 4);
      await expect(addToCart(USER, SHIRT, 2)).rejects.toThrow('Not enough stock');
      await expect(addToCart(USER, UNKNOWN, 1)).rejects.toThrow('Product not found');
      await expect(addToCart(USER, 'not-an-id', 1)).rejects.toThrow('Product not found');
    });

    it('two adds at once cannot both pass the stock check', async () => {
      const cart = await getCart(USER);
      // An uncommitted line for the shirt stops both adds at their write, after each has read
      // the cart; only the cart's row lock keeps the second from reading before the first is done.
      const blocker = await holdLocks(testDb.url, (client) =>
        client.query('INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, 1)', [cart._id, SHIRT]),
      );
      const adds = Promise.allSettled([addToCart(USER, SHIRT, 3), addToCart(USER, SHIRT, 3)]);
      await blocker.releaseWhen(2);
      const results = await adds;

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toContain('Not enough stock');
      expect(lines(await getCart(USER))).toEqual([[SHIRT, 3]]);
    });

    it('updates a quantity, and quantity 0 removes the item', async () => {
      await addToCart(USER, SHIRT, 1);
      await addToCart(USER, MUG, 1);

      expect(lines(await updateCartItem(USER, MUG, 4))).toEqual([
        [SHIRT, 1],
        [MUG, 4],
      ]);
      expect(lines(await updateCartItem(USER, SHIRT, 0))).toEqual([[MUG, 4]]);
      await expect(updateCartItem(USER, SHIRT, 1)).rejects.toThrow('Item not in cart');
    });

    it('removes one item and clears the whole cart', async () => {
      await addToCart(USER, SHIRT, 1);
      await addToCart(USER, MUG, 2);

      expect(lines(await removeFromCart(USER, SHIRT))).toEqual([[MUG, 2]]);
      expect(await clearCart(USER)).toMatchObject({ itemsCount: 0, subtotal: 0 });
    });

    it('keeps the order lines were added in, and moves updatedAt on every change', async () => {
      const first = await addToCart(USER, MUG, 1);
      const second = await addToCart(USER, SHIRT, 1);
      await addToCart(USER, MUG, 1);

      expect(lines(await getCart(USER))).toEqual([
        [MUG, 2],
        [SHIRT, 1],
      ]);
      expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.updatedAt).getTime());
    });
  });

  describe('guest cart (session)', () => {
    it('keeps items in the session and totals them like a signed-in cart', async () => {
      const session: any = {};

      await addToGuestCart(session, MUG, 2);
      const cart = await updateGuestCartItem(session, MUG, 3);

      expect(session.cart.items).toEqual([{ product: MUG, quantity: 3 }]);
      expect(cart).toMatchObject({ itemsCount: 3, subtotal: 37.5 });
      expect(await clearGuestCart(session)).toMatchObject({ itemsCount: 0, subtotal: 0 });
    });

    it('merges into the account cart on sign-in, then empties the session cart', async () => {
      const session: any = { save: (done: (err?: unknown) => void) => done() };
      await addToCart(USER, SHIRT, 1);
      await addToGuestCart(session, SHIRT, 2);
      await addToGuestCart(session, MUG, 1);

      await mergeGuestCartOnLogin(USER, session);

      expect(lines(await getCart(USER))).toEqual([
        [SHIRT, 3],
        [MUG, 1],
      ]);
      expect(session.cart.items).toEqual([]);
    });
  });
});
