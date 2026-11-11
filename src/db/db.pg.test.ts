// The Postgres schema (spec 023): migrations, money, uniqueness and the knowledge search columns,
// against a real database. `*.pg.test.ts` files need TEST_DATABASE_URL; without it they skip,
// except in CI, where they fail so a missing database can't pass by skipping (spec 019).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { checkDatabase, getDb, getPool, useDatabase } from './client';
import { brands, cartItems, carts, categories, knowledgeChunks, products, users } from './schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './test-db';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

/** The Postgres error code behind a failed query (Drizzle wraps the driver's error). */
async function pgCode(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A 1024-dimension embedding pointing mostly along one axis. */
const embedding = (axis: number, lean = 0) => Array.from({ length: 1024 }, (_, i) => (i === axis ? 1 : i === axis + 1 ? lean : 0));

describe.skipIf(!TEST_DATABASE_URL)('the Postgres schema (spec 023)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase('schema');
  }, 60_000);
  afterAll(async () => {
    await testDb?.drop();
  });

  it("applies every migration to a fresh database, with pgvector and the checkpointer's tables", async () => {
    const { rows: extensions } = await getPool().query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
    expect(extensions).toHaveLength(1);
    const { rows } = await getPool().query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    expect(rows.map((r: { table_name: string }) => r.table_name).sort()).toEqual([
      'agent_confirm_claims',
      'agent_feedback',
      'agent_turn_samples',
      'brands',
      'cart_items',
      'carts',
      'categories',
      // The checkpointer's own tables, from its setup (spec 023, stage 3).
      'checkpoint_blobs',
      'checkpoint_migrations',
      'checkpoint_writes',
      'checkpoints',
      'knowledge_chunks',
      'orders',
      'otps',
      'pending_checkouts',
      'pending_uploads',
      'products',
      'rate_limits',
      // Login sessions, as connect-pg-simple keeps them (spec 023, stage 5).
      'session',
      'users',
    ]);
  });

  it('round-trips a product with a UUID id and exact money read as a number', async () => {
    const db = getDb();
    const [category] = await db.insert(categories).values({ name: 'Mugs' }).returning();
    const [brand] = await db.insert(brands).values({ name: 'Aljo' }).returning();
    const [created] = await db
      .insert(products)
      .values({ name: 'Blue Glazed Mug', description: 'A blue mug.', price: 19.99, sku: 'MUG-BLUE', stock: 3, categoryId: category!.id, brandId: brand!.id })
      .returning();
    expect(created!.id).toMatch(UUID);

    const [read] = await db.select().from(products).where(eq(products.id, created!.id));
    expect(read).toMatchObject({ price: 19.99, stock: 3, images: [] });
    expect(typeof read!.price).toBe('number');
    // Stored exactly, not as a float.
    const { rows } = await getPool().query('SELECT price::text AS price FROM products WHERE id = $1', [created!.id]);
    expect(rows[0].price).toBe('19.99');
    expect(read!.createdAt).toBeInstanceOf(Date);
  });

  it('refuses a negative price or stock', async () => {
    const db = getDb();
    const [category] = await db.select().from(categories).limit(1);
    const [brand] = await db.select().from(brands).limit(1);
    const base = { name: 'Bad', description: 'x', sku: 'BAD', categoryId: category!.id, brandId: brand!.id };
    expect(await pgCode(db.insert(products).values({ ...base, price: -1 }))).toBe('23514');
    expect(await pgCode(db.insert(products).values({ ...base, price: 1, stock: -1 }))).toBe('23514');
  });

  it('keeps the uniqueness rules: one account per email, one cart per user, one line per product', async () => {
    const db = getDb();
    const [user] = await db.insert(users).values({ name: 'Alice', email: 'alice@example.com', password: 'hash' }).returning();
    expect(user).toMatchObject({ role: 'user', isVerified: false, refreshTokens: [] });
    expect(await pgCode(db.insert(users).values({ name: 'Other', email: 'alice@example.com', password: 'hash' }))).toBe(UNIQUE_VIOLATION);

    const [cart] = await db.insert(carts).values({ userId: user!.id }).returning();
    expect(await pgCode(db.insert(carts).values({ userId: user!.id }))).toBe(UNIQUE_VIOLATION);

    const [product] = await db.select().from(products).limit(1);
    await db.insert(cartItems).values({ cartId: cart!.id, productId: product!.id, quantity: 2 });
    expect(await pgCode(db.insert(cartItems).values({ cartId: cart!.id, productId: product!.id, quantity: 1 }))).toBe(UNIQUE_VIOLATION);
    expect(await pgCode(db.insert(cartItems).values({ cartId: cart!.id, productId: product!.id, quantity: 0 }))).toBeDefined();
  });

  it('searches knowledge chunks by words (generated tsvector) and by meaning (cosine distance)', async () => {
    const db = getDb();
    const chunk = { file: 'returns.md', title: 'Returns', contentHash: 'h', context: null };
    await db.insert(knowledgeChunks).values([
      { ...chunk, id: 'returns-1', question: 'How do refunds work?', text: 'Refunds go back to the original card within 5 days.', embedding: embedding(0) },
      { ...chunk, id: 'shipping-1', title: 'Shipping', question: 'How long is delivery?', text: 'Orders ship in 2 business days.', embedding: embedding(10) },
    ]);

    const byWords = await db
      .select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .where(sql`${knowledgeChunks.search} @@ plainto_tsquery('english', 'refund')`);
    expect(byWords.map((r) => r.id)).toEqual(['returns-1']);

    const query = `[${embedding(10, 0.2).join(',')}]`;
    const byMeaning = await db
      .select({ id: knowledgeChunks.id })
      .from(knowledgeChunks)
      .orderBy(asc(sql`${knowledgeChunks.embedding} <=> ${query}::vector`));
    expect(byMeaning.map((r) => r.id)).toEqual(['shipping-1', 'returns-1']);
  });

  it('the health check says whether the database answers', async () => {
    expect(await checkDatabase()).toBe(true);
    await useDatabase('postgres://postgres@127.0.0.1:1/nowhere');
    try {
      expect(await checkDatabase(1_000)).toBe(false);
    } finally {
      await useDatabase(testDb.url);
    }
  });

  it('works on its own database: the template every test database is cloned from stays empty', async () => {
    const { rows } = await getPool().query('SELECT current_database() AS name');
    expect(rows[0].name).toMatch(/^aljo_t_schema_/);
    const { rows: templates } = await getPool().query("SELECT datname FROM pg_database WHERE datname LIKE 'aljo_tpl_%'");
    expect(templates.length).toBeGreaterThan(0);
    const template = new pg.Client({ connectionString: testDb.url.replace(/\/[^/?]+(\?|$)/, `/${templates[0].datname}$1`) });
    await template.connect();
    try {
      const { rows: counts } = await template.query('SELECT (SELECT count(*) FROM products)::int AS products, (SELECT count(*) FROM users)::int AS users');
      expect(counts[0]).toEqual({ products: 0, users: 0 });
    } finally {
      await template.end();
    }
  });
});
