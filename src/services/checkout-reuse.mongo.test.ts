// The agent's duplicate-checkout guard (spec 010) against MongoDB, with Stripe mocked.
// Runs only when MONGO_URL is set.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

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

const MONGO_URL = process.env.MONGO_URL;

describe.skipIf(!MONGO_URL)('createOrReuseCheckoutSession', () => {
  let models: typeof import('../models/index.js');
  let orders: typeof import('./order.service.js');
  let userId = '';
  let productA = '';
  let productB = '';
  const address = { fullName: 'Jane Doe', address: '1 Main St', city: 'Lahore', postalCode: '54000', country: 'Pakistan' };

  const setCart = (items: { product: string; quantity: number }[]) =>
    models.Cart.updateOne(
      { user: userId },
      { $set: { items: items.map((i) => ({ product: new mongoose.Types.ObjectId(i.product), quantity: i.quantity })) } },
      { upsert: true },
    );

  beforeAll(async () => {
    await mongoose.connect(`${MONGO_URL}/checkout_reuse_test`);
    await mongoose.connection.dropDatabase();
    models = await import('../models/index.js');
    orders = await import('./order.service.js');
    await models.PendingCheckout.init(); // build the unique and TTL indexes
    const user = await models.User.create({ name: 'Jane', email: 'jane@example.com', password: 'secret-password', isVerified: true });
    const category = await models.Category.create({ name: 'Shoes' });
    const brand = await models.Brand.create({ name: 'Aljo' });
    const [a, b] = await models.Product.create([
      { name: 'Trail Runner', description: 'Trail shoe', price: 45, stock: 10, sku: 'TR-1', category: category._id, brand: brand._id },
      { name: 'Road Lite', description: 'Road shoe', price: 52.5, stock: 10, sku: 'RL-1', category: category._id, brand: brand._id },
    ]);
    userId = String(user._id);
    productA = String(a!._id);
    productB = String(b!._id);
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await models.PendingCheckout.deleteMany({});
    stripe.created = 0;
    await setCart([
      { product: productA, quantity: 2 },
      { product: productB, quantity: 1 },
    ]);
  });

  it('reuses the open checkout for the same cart and address instead of creating a second Stripe session', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    const second = await orders.createOrReuseCheckoutSession(userId, { ...address, city: ' lahore ' }); // same address, other spacing/case
    expect(first).toMatchObject({ reused: false, itemsCount: 3, total: 142.5 });
    expect(second).toMatchObject({ reused: true, url: first.url, pendingCheckoutId: first.pendingCheckoutId });
    expect(stripe.created).toBe(1);
    expect(await models.PendingCheckout.countDocuments({})).toBe(1);
  });

  it('creates a new session when the cart or the address changes', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    await setCart([{ product: productA, quantity: 3 }]);
    const changedCart = await orders.createOrReuseCheckoutSession(userId, address);
    const changedAddress = await orders.createOrReuseCheckoutSession(userId, { ...address, address: '2 Main St' });
    expect(new Set([first.url, changedCart.url, changedAddress.url]).size).toBe(3);
    expect(stripe.created).toBe(3);
  });

  it('creates a new session when a price changes, so Stripe never charges an old price (spec 022)', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    await models.Product.updateOne({ _id: productA }, { $set: { price: 40 } });
    const repriced = await orders.createOrReuseCheckoutSession(userId, address);
    await models.Product.updateOne({ _id: productA }, { $set: { price: 45 } });
    expect(repriced).toMatchObject({ reused: false, total: 132.5 });
    expect(repriced.url).not.toBe(first.url);
    expect(stripe.created).toBe(2);
  });

  it('does not reuse a checkout older than 23 hours', async () => {
    const first = await orders.createOrReuseCheckoutSession(userId, address);
    await models.PendingCheckout.updateOne({}, { $set: { createdAt: new Date(Date.now() - 23.5 * 60 * 60 * 1000) } });
    const again = await orders.createOrReuseCheckoutSession(userId, address);
    expect(again.reused).toBe(false);
    expect(again.url).not.toBe(first.url);
  });

  it('never reuses another customer\'s checkout', async () => {
    await orders.createOrReuseCheckoutSession(userId, address);
    const other = await models.User.create({ name: 'Other', email: 'other@example.com', password: 'secret-password', isVerified: true });
    await models.Cart.create({ user: other._id, items: [{ product: productA, quantity: 2 }, { product: productB, quantity: 1 }] });
    const theirs = await orders.createOrReuseCheckoutSession(String(other._id), address);
    expect(theirs.reused).toBe(false);
  });

  it('refuses an empty cart before calling Stripe', async () => {
    await setCart([]);
    await expect(orders.createOrReuseCheckoutSession(userId, address)).rejects.toThrow('Cart is empty');
    expect(stripe.created).toBe(0);
  });

  it('createCheckoutSession (the /checkout page) still works and now saves the hash and link', async () => {
    const { url } = await orders.createCheckoutSession(userId, address);
    const saved = await models.PendingCheckout.findOne({}).lean();
    expect(saved?.checkoutUrl).toBe(url);
    expect(saved?.cartHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
