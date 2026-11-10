// The one-time copy from MongoDB (spec 023, stage 6): old documents, as the Mongoose models stored
// them, copied into a fresh Postgres test database. Runs only where a MongoDB is at MONGO_URL (CI no
// longer has one): the copy is a one-off tool, deleted with this folder once the move is done.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { asc, eq } from 'drizzle-orm';
import type { Db, MongoClient, ObjectId } from 'mongodb';
import config from '../../src/config/config';
import { getDb } from '../../src/db/client';
import { cartItems, carts, categories, knowledgeChunks, orders, pendingCheckouts, products, users } from '../../src/db/schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../src/db/test-db';
import { hashRefreshToken } from '../../src/utils/auth.utils';
import { copyFromMongo, renderReport, uuidFromObjectId } from './copy';

vi.mock('../../src/utils/email.js', () => ({ sendOTPEmail: async () => {} }));
vi.mock('../../src/utils/cloudinary.js', () => ({ default: {} }));

const MONGO_URL = process.env.MONGO_URL;
const HOUR = 60 * 60 * 1000;

describe.skipIf(!MONGO_URL || !TEST_DATABASE_URL)('copy from MongoDB', () => {
  let testDb: TestDatabase;
  let client: MongoClient;
  let source: Db;
  const id: Record<string, ObjectId> = {};
  const uuid = (key: string) => uuidFromObjectId(id[key]!.toHexString());

  beforeAll(async () => {
    process.env.CLOUDINARY_CLOUD_NAME ??= 'test';
    process.env.CLOUDINARY_API_KEY ??= 'test';
    process.env.CLOUDINARY_API_SECRET ??= 'test';
    config.JWT_SECRET = 'test-secret';
    testDb = await createTestDatabase('copy_from_mongo');
    const mongodb = await import('mongodb');
    client = new mongodb.MongoClient(MONGO_URL!);
    await client.connect();
    source = client.db('copy_from_mongo_test');
    await source.dropDatabase();
    for (const key of ['alice', 'bob', 'ghost', 'mugs', 'bowls', 'goneCategory', 'aljo', 'mug', 'bowl', 'orphan', 'aliceCart', 'ghostCart', 'mugLine', 'order', 'ghostOrder', 'orderLine', 'pending', 'oldPending']) {
      id[key] = new mongodb.ObjectId();
    }
    const at = new Date('2026-09-01T10:00:00Z');
    const address = { fullName: 'Alice', address: '1 Lane', city: 'Lahore', postalCode: '54000', country: 'Pakistan' };
    await source.collection('users').insertMany([
      { _id: id.alice, name: 'Alice', email: 'alice@example.com', password: await bcrypt.hash('Secret#123', 4), isVerified: true, refreshTokens: [hashRefreshToken('alice-device')], role: 'user', createdAt: at, updatedAt: at, __v: 0 },
      // An old document from before timestamps, with only the required fields.
      { _id: id.bob, name: 'Bob', email: 'bob@example.com', password: await bcrypt.hash('Other#456', 4), role: 'admin' },
    ]);
    await source.collection('categories').insertMany([
      { _id: id.mugs, name: 'Mugs', createdAt: at, updatedAt: at },
      { _id: id.bowls, name: 'Bowls', createdAt: at, updatedAt: at },
    ]);
    await source.collection('brands').insertOne({ _id: id.aljo, name: 'Aljo', createdAt: at, updatedAt: at });
    await source.collection('products').insertMany([
      { _id: id.mug, name: 'Blue Mug', description: 'A mug.', price: 21.5, images: ['https://img/mug.png'], stock: 5, category: id.mugs, brand: id.aljo, createdAt: at, updatedAt: at },
      { _id: id.bowl, name: 'Stone Bowl', description: 'A bowl.', price: 45, images: [], stock: 2, category: id.bowls, brand: id.aljo, createdAt: at, updatedAt: at },
      // Its category was deleted: MongoDB allowed it, Postgres doesn't.
      { _id: id.orphan, name: 'Lost Cup', description: 'A cup.', price: 9, images: [], stock: 1, category: id.goneCategory, brand: id.aljo, createdAt: at, updatedAt: at },
    ]);
    await source.collection('carts').insertMany([
      {
        _id: id.aliceCart,
        user: id.alice,
        items: [
          { _id: id.mugLine, product: id.mug, quantity: 2 },
          { _id: new mongodb.ObjectId(), product: id.orphan, quantity: 1 }, // its product isn't copied
          { _id: new mongodb.ObjectId(), product: id.bowl, quantity: 1 },
        ],
        createdAt: at,
        updatedAt: at,
      },
      { _id: id.ghostCart, user: id.ghost, items: [{ _id: new mongodb.ObjectId(), product: id.mug, quantity: 1 }], createdAt: at, updatedAt: at },
    ]);
    await source.collection('orders').insertMany([
      {
        _id: id.order,
        user: id.alice,
        items: [{ _id: id.orderLine, product: id.mug, name: 'Blue Mug', price: 21.5, quantity: 2, image: 'https://img/mug.png' }],
        subtotal: 43,
        tax: 0,
        shipping: 0,
        total: 43,
        status: 'shipped',
        paymentStatus: 'paid',
        paymentMethod: 'stripe',
        stripeSessionId: 'cs_live_1',
        shippingAddress: address,
        paidAt: at,
        createdAt: at,
        updatedAt: at,
      },
      // The customer deleted their account.
      { _id: id.ghostOrder, user: id.ghost, items: [], subtotal: 9, tax: 0, shipping: 0, total: 9, status: 'delivered', paymentStatus: 'paid', paymentMethod: 'stripe', shippingAddress: address, createdAt: at, updatedAt: at },
    ]);
    const now = Date.now();
    await source.collection('pendingcheckouts').insertMany([
      { _id: id.pending, stripeSessionId: 'cs_open', user: id.alice, items: [{ _id: new mongodb.ObjectId(), product: id.bowl, name: 'Stone Bowl', price: 45, quantity: 1, image: '' }], shippingAddress: address, subtotal: 45, tax: 0, shipping: 0, total: 45, cartHash: 'h', checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_open', createdAt: new Date(now - HOUR) },
      { _id: id.oldPending, stripeSessionId: 'cs_old', user: id.alice, items: [], shippingAddress: address, subtotal: 1, tax: 0, shipping: 0, total: 1, createdAt: new Date(now - 30 * HOUR) },
    ]);
    const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    await source.collection('knowledge_chunks').insertMany([
      { _id: 'returns.md#how-long', file: 'returns.md', title: 'Returns', question: 'How long?', text: '30 days.', context: null, embedding, contentHash: 'abc', updatedAt: at } as never,
      { _id: 'broken.md#x', file: 'broken.md', title: 'Broken', question: 'X?', text: 'Y.', context: null, embedding: [1, 2, 3], contentHash: 'def', updatedAt: at } as never,
    ]);
    await source.collection('otps').insertOne({ email: 'alice@example.com', otp: '123456', expiresAt: new Date(now + HOUR) });
    await source.collection('sessions').insertMany([{ _id: 'sid-1' as never, session: '{}' }, { _id: 'sid-2' as never, session: '{}' }]);
  }, 60_000);

  afterAll(async () => {
    await source?.dropDatabase();
    await client?.close();
    await testDb?.drop();
  });

  it('a dry run checks everything and writes nothing', async () => {
    const report = await copyFromMongo(source, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.tables.users).toMatchObject({ source: 2, copied: 2 });
    expect(await getDb().select().from(users)).toEqual([]);
    expect(await getDb().select().from(orders)).toEqual([]);
    expect(renderReport(report)).toContain('dry run: checked, and nothing was written');
  });

  it('copies every collection, maps every reference, and says what it left out and why', async () => {
    const report = await copyFromMongo(source);

    expect(Object.fromEntries(Object.entries(report.tables).map(([name, t]) => [name, [t.copied, t.source]]))).toEqual({
      users: [2, 2],
      categories: [2, 2],
      brands: [1, 1],
      products: [2, 3],
      carts: [1, 2],
      orders: [2, 2],
      pending_checkouts: [1, 2],
      knowledge_chunks: [1, 2],
    });
    expect(report.tables.products!.skipped).toEqual([{ id: id.orphan!.toHexString(), reason: 'its category no longer exists' }]);
    expect(report.tables.carts!.skipped).toEqual([{ id: id.ghostCart!.toHexString(), reason: 'its customer no longer exists' }]);
    expect(report.tables.carts!.notes).toEqual(['1 cart line(s) left out: the product no longer exists']);
    expect(report.tables.orders!.notes).toEqual(['1 order(s) kept without a customer: the account no longer exists']);
    expect(report.tables.pending_checkouts!.skipped).toEqual([{ id: id.oldPending!.toHexString(), reason: 'expired' }]);
    expect(report.notCopied).toEqual({ otps: 1, sessions: 2 });

    const db = getDb();
    const [mug] = await db.select().from(products).where(eq(products.id, uuid('mug')));
    expect(mug).toMatchObject({ name: 'Blue Mug', price: 21.5, stock: 5, categoryId: uuid('mugs'), brandId: uuid('aljo'), images: ['https://img/mug.png'] });
    const [bob] = await db.select().from(users).where(eq(users.id, uuid('bob')));
    expect(bob).toMatchObject({ role: 'admin', isVerified: false, refreshTokens: [] });
    expect(bob!.createdAt.getTime()).toBe(id.bob!.getTimestamp().getTime()); // no timestamps: the ObjectId's time

    const [cart] = await db.select().from(carts).where(eq(carts.userId, uuid('alice')));
    expect(cart!.id).toBe(uuid('aliceCart'));
    const lines = await db.select().from(cartItems).where(eq(cartItems.cartId, cart!.id)).orderBy(asc(cartItems.position));
    expect(lines.map((line) => [line.id, line.productId, line.quantity])).toEqual([
      [uuid('mugLine'), uuid('mug'), 2],
      [expect.any(String), uuid('bowl'), 1],
    ]);

    const [order] = await db.select().from(orders).where(eq(orders.id, uuid('order')));
    expect(order).toMatchObject({ userId: uuid('alice'), total: 43, status: 'shipped', stripeSessionId: 'cs_live_1' });
    expect(order!.items).toEqual([{ _id: uuid('orderLine'), product: uuid('mug'), name: 'Blue Mug', price: 21.5, quantity: 2, image: 'https://img/mug.png' }]);
    expect((await db.select().from(orders).where(eq(orders.id, uuid('ghostOrder'))))[0]!.userId).toBeNull();

    const [pending] = await db.select().from(pendingCheckouts);
    expect(pending).toMatchObject({ id: uuid('pending'), userId: uuid('alice'), stripeSessionId: 'cs_open' });
    expect(pending!.expiresAt.getTime() - pending!.createdAt.getTime()).toBe(24 * HOUR);
    const chunks = await db.select().from(knowledgeChunks);
    expect(chunks.map((chunk) => [chunk.id, chunk.embedding.length])).toEqual([['returns.md#how-long', 1024]]);
  });

  it('the copied store works: the same password signs in, the device stays signed in, orders read back', async () => {
    const { loginWithPassword, refreshAccessToken } = await import('../../src/services/auth.service');
    const { getOrderById } = await import('../../src/services/order.service');
    const { getCart } = await import('../../src/services/cart.service');

    expect((await loginWithPassword('alice@example.com', 'Secret#123')).user._id).toBe(uuid('alice'));
    await expect(refreshAccessToken('alice-device')).resolves.toHaveProperty('accessToken');
    expect(await getOrderById(uuid('order'))).toMatchObject({ user: { _id: uuid('alice'), name: 'Alice', email: 'alice@example.com' }, items: [{ product: { _id: uuid('mug'), name: 'Blue Mug' } }] });
    expect(await getCart(uuid('alice'))).toMatchObject({ itemsCount: 3, subtotal: 88 });
  });

  it('running it again updates rather than duplicates, and follows changes made since', async () => {
    await source.collection('products').updateOne({ _id: id.mug }, { $set: { price: 19.99 } });
    await source.collection('carts').updateOne({ _id: id.aliceCart }, { $pull: { items: { product: id.bowl } } as never });

    const report = await copyFromMongo(source);

    expect(report.tables.users!.copied).toBe(2);
    expect(await getDb().select().from(users)).toHaveLength(2);
    expect(await getDb().select().from(categories)).toHaveLength(2);
    expect((await getDb().select().from(products).where(eq(products.id, uuid('mug'))))[0]!.price).toBe(19.99);
    expect((await getDb().select().from(cartItems)).map((line) => line.productId)).toEqual([uuid('mug')]);
  });
});
