// Response-shape contract (spec 023): every service the routes send from returns the same fields,
// with the same types, as the MongoDB version did. contracts.fixture.json holds those shapes, as
// captured from the services at 4a334c8 and reduced to field → type ('id', 'date', 'string', …);
// this test replays the capture's steps against Postgres and compares. `__v` is gone on purpose.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

const stripe = vi.hoisted(() => ({ userId: '' }));
vi.mock('../config/stripe.js', () => ({
  stripeClient: {
    checkout: { sessions: { create: async () => ({ id: 'cs_test_shape', url: 'https://checkout.stripe.com/c/pay/cs_test_shape' }) } },
    webhooks: {
      constructEvent: () => ({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_shape', metadata: { userId: stripe.userId } } } }),
    },
  },
}));
vi.mock('../utils/order.confirmation.email.js', () => ({ sendOrderConfirmationEmail: async () => {} }));

const ID = /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** A response reduced to its fields and their types, as the fixture holds them. */
function skeleton(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length ? [skeleton(value[0])] : [];
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => key !== '__v')
        .sort()
        .map((key) => [key, skeleton(record[key])]),
    );
  }
  if (typeof value === 'string') return ID.test(value) ? 'id' : DATE.test(value) ? 'date' : 'string';
  return typeof value;
}

/** As JSON sends it: dates become strings, undefined fields disappear. */
const sent = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe.skipIf(!TEST_DATABASE_URL)('the API keeps its response shapes (spec 023)', () => {
  let testDb: TestDatabase;
  const expected = JSON.parse(readFileSync(new URL('./contracts.fixture.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  beforeAll(async () => {
    process.env.CLOUDINARY_CLOUD_NAME ??= 'test';
    process.env.CLOUDINARY_API_KEY ??= 'test';
    process.env.CLOUDINARY_API_SECRET ??= 'test';
    testDb = await createTestDatabase('contracts');

    const { getDb } = await import('../db/client');
    const { users } = await import('../db/schema/index');
    const cat = await import('./category.service');
    const brand = await import('./brand.service');
    const prod = await import('./product.service');
    const cart = await import('./cart.service');
    const guest = await import('./guest-cart.service');
    const order = await import('./order.service');
    const adminOrder = await import('./admin-order.service');
    const adminCart = await import('./admin-cart.service');
    const adminUser = await import('./admin-user.service');
    const dash = await import('./admin-dashboard.service');
    const auth = await import('./auth.service');
    const upload = await import('./upload.service');

    // The same steps, in the same order, as the capture.
    out.createCategory = sent(await cat.createCategoryService('Mugs'));
    out.getAllCategories = sent(await cat.getAllCategoriesService());
    const c = (await cat.getAllCategoriesService())[0]!;
    out.createBrand = sent(await brand.createBrandService('Aljo'));
    const b = (await brand.getAllBrandsService())[0]!;
    out.createProduct = sent(await prod.createProductService('Blue Mug', 'A mug', 19.99, 5, String(c._id), String(b._id)));
    out.getAllProducts = sent(await prod.getAllProductsService({}));
    const p = (out.getAllProducts as { products: { _id: string }[] }).products[0]!;
    out.getProductById = sent(await prod.getProductByIdService(p._id));
    out.updateProduct = sent(await prod.updateProductService(p._id, { price: 21.5 }));

    const [user] = await getDb().insert(users).values({ name: 'Alice', email: 'alice@example.com', password: 'hash', isVerified: true }).returning();
    const userId = user!.id;
    stripe.userId = userId;
    out.getUserById = sent(await auth.getUserById(userId));
    out.addToCart = sent(await cart.addToCart(userId, p._id, 2));
    out.getCart = sent(await cart.getCart(userId));
    const session = { save: (done: (err?: unknown) => void) => done() } as never;
    out.addToGuestCart = sent(await guest.addToGuestCart(session, p._id, 1));

    const address = { fullName: 'Alice', address: '1 Lane', city: 'Lahore', postalCode: '54000', country: 'PK' };
    out.createCheckoutSession = sent(await order.createCheckoutSession(userId, address));
    out.webhook = sent(await order.handleStripeWebhook(Buffer.from('x'), 'sig'));
    out.getMyOrders = sent(await order.getMyOrders(userId));
    const o = (out.getMyOrders as { _id: string }[])[0]!;
    out.getMyOrderById = sent(await order.getMyOrderById(userId, o._id));
    out.getUserOrders = sent(await order.getUserOrders(userId));
    out.getOrderById = sent(await order.getOrderById(o._id));
    out.updateOrderStatus = sent(await order.updateOrderStatus(o._id, 'shipped'));
    out.getAllOrders = sent(await adminOrder.getAllOrdersService({}));
    out.adminUpdateOrderDetails = sent(await adminOrder.adminUpdateOrderDetailsService(o._id, { tax: 1 }));
    await cart.addToCart(userId, p._id, 1);
    out.getAllCarts = sent(await adminCart.getAllCartsService({}));
    out.getCartByUserId = sent(await adminCart.getCartByUserIdService(userId));
    out.getAllUsers = sent(await adminUser.getAllUsersService({}));
    out.dashboard = sent(await dash.getDashboardSummaryService());
    out.updateUserProfile = sent(await auth.updateUserProfile(userId, 'Alice B'));
    out.createAvatarUpload = sent(
      await upload.createAvatarUpload(userId, { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'me.png', size: 1 }),
    );
    out.deleteCategory = sent(await cat.createCategoryService('Temp').then((t) => cat.deleteCategoryService(String(t._id))));
  }, 60_000);

  afterAll(async () => {
    await testDb?.drop();
  });

  it('replays every captured step', () => {
    expect(Object.keys(out).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.keys(JSON.parse(readFileSync(new URL('./contracts.fixture.json', import.meta.url), 'utf8')) as object))('%s', (step) => {
    expect(skeleton(out[step])).toEqual(expected[step]);
  });

  it('never returns a password or refresh tokens for a user', () => {
    expect(out.getUserById).not.toHaveProperty('password');
    expect(out.getUserById).not.toHaveProperty('refreshTokens');
  });

  it('keeps money exact: prices, totals and the dashboard read as plain numbers', () => {
    expect(out.getCartByUserId).toMatchObject({ subtotal: 21.5, itemsCount: 1 });
    expect(out.adminUpdateOrderDetails).toMatchObject({ subtotal: 43, tax: 1, total: 44 });
    expect((out.dashboard as { totals: unknown }).totals).toEqual({ revenue: 44, orders: 1, users: 1, products: 1 });
  });
});
