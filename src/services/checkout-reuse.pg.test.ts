// The agent's duplicate-checkout guard (spec 010) against Postgres, with Stripe mocked.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { brands, cartItems, categories, pendingCheckouts, products, users } from '../db/schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import { ensureCart } from './cart.service';
import * as orders from './order.service';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

const stripe = vi.hoisted(() => ({ created: 0 }));
vi.mock('../config/stripe.js', () => ({
  stripeClient: {
    checkout: {
      sessions: {
        create: async () => {
          stripe.created += 1;
          return { id: `cs_test_${stripe.created}`, url: `https://checkout.stripe.com/c/pay/cs_test_${stripe.created}` };
        },
      },
    },
  },
}));

describe.skipIf(!TEST_DATABASE_URL)('createOrReuseCheckoutSession', () => {
  let testDb: TestDatabase;
  let userId = '';
  let productA = '';
  let productB = '';
  const address = { fullName: 'Jane Doe', address: '1 Main St', city: 'Lahore', postalCode: '54000', country: 'Pakistan' };

  const setCart = async (forUser: string, items: { product: string; quantity: number }[]) => {
    const cart = await ensureCart(getDb(), forUser);
    await getDb().delete(cartItems).where(eq(cartItems.cartId, cart.id));
    if (items.length) {
      await getDb()
        .insert(cartItems)
        .values(items.map((item, position) => ({ cartId: cart.id, productId: item.product, quantity: item.quantity, position })));
    }
  };
  const newUser = async (name: string, email: string) =>
    (await getDb().insert(users).values({ name, email, password: 'hash', isVerified: true }).returning())[0]!.id;

  beforeAll(async () => {
    testDb = await createTestDatabase('checkout_reuse');
    userId = await newUser('Jane', 'jane@example.com');
    const [category] = await getDb().insert(categories).values({ name: 'Shoes' }).returning();
    const [brand] = await getDb().insert(brands).values({ name: 'Aljo' }).returning();
    const [a, b] = await getDb()
      .insert(products)
      .values([
        { name: 'Trail Runner', description: 'Trail shoe', price: 45, stock: 10, sku: 'TR-1', categoryId: category!.id, brandId: brand!.id },
        { name: 'Road Lite', description: 'Road shoe', price: 52.5, stock: 10, sku: 'RL-1', categoryId: category!.id, brandId: brand!.id },
      ])
      .returning();
    productA = a!.id;
    productB = b!.id;
  }, 60_000);

  afterAll(async () => {
    await testDb?.drop();
  });

  beforeEach(async () => {
    await getDb().delete(pendingCheckouts);
    stripe.created = 0;
    await setCart(userId, [
      { product: productA, quantity: 2 },
      { product: productB, quantity: 1 },
    ]);
  });

  const pendingCount = async () => (await getDb().select({ id: pendingCheckouts.id }).from(pendingCheckouts)).length;

  it('reuses the open checkout for the same cart and address instead of creating a second Stripe session', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    const second = await orders.createOrReuseCheckoutSession(userId, { ...address, city: ' lahore ' }); // same address, other spacing/case
    expect(first).toMatchObject({ reused: false, itemsCount: 3, total: 142.5 });
    expect(second).toMatchObject({ reused: true, url: first.url, pendingCheckoutId: first.pendingCheckoutId });
    expect(stripe.created).toBe(1);
    expect(await pendingCount()).toBe(1);
  });

  it('creates a new session when the cart or the address changes', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    await setCart(userId, [{ product: productA, quantity: 3 }]);
    const changedCart = await orders.createOrReuseCheckoutSession(userId, address);
    const changedAddress = await orders.createOrReuseCheckoutSession(userId, { ...address, address: '2 Main St' });
    expect(new Set([first.url, changedCart.url, changedAddress.url]).size).toBe(3);
    expect(stripe.created).toBe(3);
  });

  it('creates a new session when a price changes, so Stripe never charges an old price (spec 022)', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    await getDb().update(products).set({ price: 40 }).where(eq(products.id, productA));
    const repriced = await orders.createOrReuseCheckoutSession(userId, address);
    await getDb().update(products).set({ price: 45 }).where(eq(products.id, productA));
    expect(repriced).toMatchObject({ reused: false, total: 132.5 });
    expect(repriced.url).not.toBe(first.url);
    expect(stripe.created).toBe(2);
  });

  it('does not reuse a checkout older than 23 hours', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    await getDb()
      .update(pendingCheckouts)
      .set({ createdAt: new Date(Date.now() - 23.5 * 60 * 60 * 1000) });
    const again = await orders.createOrReuseCheckoutSession(userId, address);
    expect(again.reused).toBe(false);
    expect(again.url).not.toBe(first.url);
  });

  it("never reuses another customer's checkout", async () => {
    await orders.createOrReuseCheckoutSession(userId, address);
    const other = await newUser('Other', 'other@example.com');
    await setCart(other, [
      { product: productA, quantity: 2 },
      { product: productB, quantity: 1 },
    ]);
    const theirs = await orders.createOrReuseCheckoutSession(other, address);
    expect(theirs.reused).toBe(false);
  });

  it('refuses an empty cart before calling Stripe', async () => {
    await setCart(userId, []);
    await expect(orders.createOrReuseCheckoutSession(userId, address)).rejects.toThrow('Cart is empty');
    expect(stripe.created).toBe(0);
  });

  it('createCheckoutSession (the /checkout page) still works and saves the hash, link and a 24-hour expiry', async () => {
    const { url } = await orders.createCheckoutSession(userId, address);
    const [saved] = await getDb().select().from(pendingCheckouts);
    expect(saved?.checkoutUrl).toBe(url);
    expect(saved?.cartHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved!.expiresAt.getTime() - saved!.createdAt.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -4);
    // Each line keeps its own id, as the Mongo subdocuments did.
    expect(saved!.items.map((item) => item._id)).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/), expect.stringMatching(/^[0-9a-f-]{36}$/)]);
  });
});
