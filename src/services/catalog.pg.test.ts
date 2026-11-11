// Categories, brands and product search against Postgres (spec 023).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { cartItems, products, users } from '../db/schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import { createBrandService, deleteBrandService } from './brand.service';
import { addToCart } from './cart.service';
import { createCategoryService, deleteCategoryService, updateCategoryService } from './category.service';
import { createProductService, deleteProductService, getAllProductsService, getProductByIdService } from './product.service';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

vi.mock('../utils/cloudinary.js', () => ({ default: { uploader: { destroy: async () => ({}) } } }));

describe.skipIf(!TEST_DATABASE_URL)('the catalog on Postgres', () => {
  let testDb: TestDatabase;
  let mugs = '';
  let bowls = '';
  let aljo = '';
  let other = '';
  const ids: Record<string, string> = {};
  const names = (result: { products: { name: string }[] }) => result.products.map((p) => p.name);

  beforeAll(async () => {
    testDb = await createTestDatabase('catalog');
    mugs = (await createCategoryService('Mugs'))._id;
    bowls = (await createCategoryService('Bowls'))._id;
    aljo = (await createBrandService('Aljo'))._id;
    other = (await createBrandService('Other'))._id;
    // Created one after another, so "newest" is the reverse of this list.
    for (const [name, description, price, stock, category, brand] of [
      ['Blue Mug', 'A blue glazed mug.', 20, 3, mugs, aljo],
      ['Travel Cup', 'Fits any blue mug lid.', 15, 0, mugs, other],
      ['Stone Bowl', 'A heavy bowl.', 45, 5, bowls, aljo],
    ] as const) {
      ids[name] = (await createProductService(name, description, price, stock, category, brand))._id;
    }
  }, 60_000);

  afterAll(async () => {
    await testDb?.drop();
  });

  it('keeps category names unique whatever their case', async () => {
    await expect(createCategoryService(' mugs ')).rejects.toThrow('Category with this name already exists');
    await expect(updateCategoryService(bowls, 'MUGS')).rejects.toThrow('Another category with this name already exists');
  });

  it('refuses to delete a category or brand that products still use, and deletes one that is free', async () => {
    await expect(deleteCategoryService(mugs)).rejects.toThrow('Category is still used by products. Move or delete them first.');
    await expect(deleteBrandService(aljo)).rejects.toThrow('Brand is still used by products. Move or delete them first.');
    const spare = await createCategoryService('Spare');
    await expect(deleteCategoryService(spare._id)).resolves.toMatchObject({ _id: spare._id, name: 'Spare' });
    await expect(deleteCategoryService('nope')).rejects.toThrow('Invalid category ID format');
  });

  it('refuses a product whose category or brand does not exist', async () => {
    await expect(createProductService('X', 'x', 1, 1, '00000000-0000-4000-8000-000000000000', aljo)).rejects.toThrow('Invalid category or brand ID');
    await expect(createProductService('X', 'x', 1, 1, mugs, 'nope')).rejects.toThrow('Invalid category or brand ID');
  });

  it('finds products by words in the name or description, ignoring case', async () => {
    expect(names(await getAllProductsService({ search: 'BLUE', sort: 'newest' }))).toEqual(['Travel Cup', 'Blue Mug']);
    // Relevance puts name matches first.
    expect(names(await getAllProductsService({ search: 'blue', sort: 'relevance' }))).toEqual(['Blue Mug', 'Travel Cup']);
  });

  it('filters by category, brand, price and stock; an id that is not one matches nothing', async () => {
    expect(names(await getAllProductsService({ category: mugs }))).toEqual(['Travel Cup', 'Blue Mug']);
    expect(names(await getAllProductsService({ category: [mugs, bowls], brand: aljo }))).toEqual(['Stone Bowl', 'Blue Mug']);
    expect(names(await getAllProductsService({ minPrice: 16, maxPrice: 45, sort: 'price_low' }))).toEqual(['Blue Mug', 'Stone Bowl']);
    expect(names(await getAllProductsService({ sort: 'price_high' }))).toEqual(['Stone Bowl', 'Blue Mug', 'Travel Cup']);
    expect(names(await getAllProductsService({ inStock: true, category: mugs }))).toEqual(['Blue Mug']);
    expect(names(await getAllProductsService({ category: 'not-an-id' }))).toEqual([]);
  });

  it('pages the results', async () => {
    const page = await getAllProductsService({ page: 2, limit: 2 });
    expect(names(page)).toEqual(['Blue Mug']);
    expect(page.pagination).toEqual({ currentPage: 2, totalPages: 2, totalItems: 3, hasNext: false, hasPrev: true });
  });

  it('returns a product with its category and brand, and says when it is missing', async () => {
    expect(await getProductByIdService(ids['Blue Mug']!)).toMatchObject({ name: 'Blue Mug', price: 20, category: { _id: mugs, name: 'Mugs' }, brand: { _id: aljo, name: 'Aljo' } });
    await expect(getProductByIdService('00000000-0000-4000-8000-000000000000')).rejects.toThrow('Product not found');
    await expect(getProductByIdService('nope')).rejects.toThrow('Invalid product ID format');
  });

  it('a deleted product leaves every cart it was in', async () => {
    const [user] = await getDb().insert(users).values({ name: 'Ann', email: 'ann@example.com', password: 'hash' }).returning();
    const temp = await createProductService('Temp Mug', 'Gone soon.', 5, 5, mugs, aljo);
    await addToCart(user!.id, temp._id, 1);

    await deleteProductService(temp._id);

    expect(await getDb().select().from(products).where(eq(products.id, temp._id))).toHaveLength(0);
    expect(await getDb().select().from(cartItems).where(eq(cartItems.productId, temp._id))).toHaveLength(0);
  });
});
