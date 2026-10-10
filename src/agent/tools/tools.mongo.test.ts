// Real queries behind the read tools, against MongoDB (spec 005). Runs only when
// MONGO_URL is set (e.g. mongodb://127.0.0.1:27017 with a local mongo:7 container).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';

const MONGO_URL = process.env.MONGO_URL;

describe.skipIf(!MONGO_URL)('read tools against MongoDB', () => {
  // product.service and auth.service import the Cloudinary config, which throws without these.
  process.env.CLOUDINARY_CLOUD_NAME ??= 'test';
  process.env.CLOUDINARY_API_KEY ??= 'test';
  process.env.CLOUDINARY_API_SECRET ??= 'test';

  let models: typeof import('../../models/index.js');
  let tools: typeof import('./index.js');
  let products: typeof import('../../services/product.service.js');
  const ids = { owner: '', other: '', shoes: '', aljo: '', inStockProduct: '', soldOut: '', order: '' };

  const call = async (userId: string, name: string, args: Record<string, unknown> = {}) => {
    const found = tools.buildToolsForRequest({ userId }).find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed tool JSON is inspected freely in assertions
    return JSON.parse(String(await found.invoke(args))) as Record<string, any>;
  };

  beforeAll(async () => {
    await mongoose.connect(`${MONGO_URL}/agent_tools_test`);
    await mongoose.connection.dropDatabase();
    models = await import('../../models/index.js');
    tools = await import('./index.js');
    products = await import('../../services/product.service.js');

    const [owner, other] = await models.User.create([
      { name: 'Owner', email: 'owner@example.com', password: 'secret-password', isVerified: true },
      { name: 'Other', email: 'other@example.com', password: 'secret-password', isVerified: true },
    ]);
    const shoes = await models.Category.create({ name: 'Shoes' });
    const aljo = await models.Brand.create({ name: 'Aljo' });
    const [inStock, soldOut] = await models.Product.create([
      { name: 'Trail (Runner)', description: 'Light trail shoe', price: 45, stock: 3, sku: 'TR-1', category: shoes._id, brand: aljo._id },
      { name: 'Road Runner', description: 'Road shoe', price: 60, stock: 0, sku: 'RR-1', category: shoes._id, brand: aljo._id },
    ]);
    const order = await models.Order.create({
      user: owner!._id,
      items: [{ product: inStock!._id, name: 'Trail (Runner)', price: 45, quantity: 1 }],
      subtotal: 45,
      tax: 0,
      shipping: 0,
      total: 45,
      status: 'shipped',
      paymentStatus: 'paid',
      paymentMethod: 'stripe',
      shippingAddress: { fullName: 'Owner', address: '1 Main St', city: 'Lahore', postalCode: '54000', country: 'Pakistan' },
    });
    Object.assign(ids, {
      owner: String(owner!._id),
      other: String(other!._id),
      shoes: String(shoes._id),
      aljo: String(aljo._id),
      inStockProduct: String(inStock!._id),
      soldOut: String(soldOut!._id),
      order: String(order._id),
    });
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('search_products matches regex characters literally', async () => {
    const out = await call(ids.owner, 'search_products', { query: '(Runner)' });
    expect(out.results.map((r: { name: string }) => r.name)).toEqual(['Trail (Runner)']);
    expect((await call(ids.owner, 'search_products', { query: '.*' })).totalItems).toBe(0);
  });

  it('search_products resolves names, filters stock and sorts by price', async () => {
    const all = await call(ids.owner, 'search_products', { categories: ['shoes'], brands: ['ALJO'], sort: 'price_desc' });
    expect(all.results.map((r: { name: string }) => r.name)).toEqual(['Road Runner', 'Trail (Runner)']);
    const inStock = await call(ids.owner, 'search_products', { categories: ['Shoes'], in_stock: true });
    expect(inStock.results.map((r: { name: string }) => r.name)).toEqual(['Trail (Runner)']);
  });

  it('getAllProductsService without inStock still returns sold-out products (REST unchanged)', async () => {
    const { products: list } = await products.getAllProductsService({ category: ids.shoes });
    expect(list.map((p) => String(p._id)).sort()).toEqual([ids.inStockProduct, ids.soldOut].sort());
  });

  it('get_product_details returns related products from the same category', async () => {
    const out = await call(ids.owner, 'get_product_details', { product_id: ids.inStockProduct });
    expect(out.related.map((r: { id: string }) => r.id)).toEqual([ids.soldOut]);
    expect(out.description).toContain('<untrusted_content source="product_description">');
  });

  it('get_order_status is owner-scoped: another user gets the same answer as a missing order', async () => {
    expect((await call(ids.owner, 'get_order_status', { order_id: ids.order })).status).toBe('shipped');
    const otherUser = await call(ids.other, 'get_order_status', { order_id: ids.order });
    const missing = await call(ids.owner, 'get_order_status', { order_id: new mongoose.Types.ObjectId().toString() });
    expect(otherUser).toEqual({ error: 'No order with that id on your account.' });
    expect(missing).toEqual(otherUser);
  });

  it('view_orders and view_profile see only the caller\'s data', async () => {
    expect((await call(ids.owner, 'view_orders')).totalMatching).toBe(1);
    expect((await call(ids.other, 'view_orders')).totalMatching).toBe(0);
    expect((await call(ids.other, 'view_profile')).email).toBe('other@example.com');
  });
});
