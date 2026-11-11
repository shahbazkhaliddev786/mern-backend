// One-time copy of the store's MongoDB data into Postgres (spec 023, stage 6). Run it against a
// Neon branch first, then (the owner's call) against production:
//   MONGO_SOURCE_URL="mongodb+srv://…/aljo-store" DATABASE_URL="postgresql://…" npm run db:copy-from-mongo -- --dry-run
//
// - Every ObjectId becomes a UUID derived from it (UUIDv5), so references keep pointing at the same
//   records, and running the copy again updates the rows instead of adding new ones.
// - Everything is written in one transaction: the copy lands whole or not at all. `--dry-run` runs
//   the same writes and rolls them back, so constraints and counts are checked without a trace.
// - It prints what it copied per table and lists anything it left out, with the reason. It fails
//   (exit 1) if the rows in Postgres don't add up.
// - Short-lived records (codes, uploads, sessions, logs, limits) and the agent's conversations aren't
//   copied: they expire anyway or start fresh.
//
// The MongoDB driver is this folder's own dependency, so the app keeps no MongoDB package. Delete
// the folder once the move is done.

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db, Document } from 'mongodb';
import { describeError, getDb, type Executor } from '../../src/db/client.js';
import {
  brands,
  cartItems,
  carts,
  categories,
  knowledgeChunks,
  orders,
  pendingCheckouts,
  products,
  users,
  type OrderItem,
  type ShippingAddress,
} from '../../src/db/schema/index.js';

// --- Ids

/** The namespace of the UUIDs made from this store's ObjectIds. Never change it: re-runs rely on it. */
const NAMESPACE = Buffer.from('6f1c2a9e4b7d4e0f8a3c5d2e1b0f9a87', 'hex');

/** The UUID (version 5) for an ObjectId's hex string: the same ObjectId always gives the same UUID. */
export function uuidFromObjectId(hex: string): string {
  const bytes = crypto.createHash('sha1').update(NAMESPACE).update(hex.toLowerCase()).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** An ObjectId's hex string, or null for anything that isn't one. */
function hexOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'toHexString' in value && typeof value.toHexString === 'function') return String(value.toHexString());
  return typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value) ? value.toLowerCase() : null;
}

/** The document's own date, else the creation time inside its ObjectId (old documents had no timestamps). */
function dateOf(doc: Document, field: string): Date {
  const value = doc[field];
  if (value instanceof Date) return value;
  const id = doc._id as { getTimestamp?: () => Date } | undefined;
  return id?.getTimestamp?.() ?? new Date();
}

const optional = <T>(value: T | undefined | null): T | null => (value === undefined ? null : value);

/** A stable stand-in for a missing ObjectId, made from what identifies the record instead. */
const derivedHex = (...parts: string[]) => crypto.createHash('md5').update(parts.join(':')).digest('hex').slice(0, 24);

// --- The report

export interface TableReport {
  /** Documents in MongoDB. */
  source: number;
  /** Rows written to Postgres. */
  copied: number;
  /** Documents left out, with the reason. */
  skipped: { id: string; reason: string }[];
  /** Anything else worth knowing, e.g. orders kept without a user. */
  notes: string[];
}

export interface CopyReport {
  dryRun: boolean;
  tables: Record<string, TableReport>;
  /** The collections that aren't copied, with their document counts. */
  notCopied: Record<string, number>;
}

/** The collections the copy reads, by the table they go to. */
const COPIED = {
  users: 'users',
  categories: 'categories',
  brands: 'brands',
  products: 'products',
  carts: 'carts',
  orders: 'orders',
  pending_checkouts: 'pendingcheckouts',
  knowledge_chunks: 'knowledge_chunks',
} as const;

class DryRunRollback extends Error {}

export class CountMismatchError extends Error {}

// --- The copy

/** Writes rows in batches, replacing any row with the same primary key (so a re-run updates). */
async function upsert(tx: Executor, table: PgTable, key: unknown, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = getTableColumns(table);
  const set = Object.fromEntries(
    Object.entries(columns)
      // The key stays; generated columns (the knowledge's search vector) are Postgres's to compute.
      .filter(([, column]) => !column.primary && !column.generated)
      .map(([name, column]) => [name, sql.raw(`excluded."${column.name}"`)]),
  );
  for (let start = 0; start < rows.length; start += 500) {
    await tx
      .insert(table)
      .values(rows.slice(start, start + 500) as never)
      .onConflictDoUpdate({ target: key as never, set: set as never });
  }
}

const PENDING_CHECKOUT_LIFETIME_MS = 24 * 60 * 60 * 1000;

export async function copyFromMongo(source: Db, { dryRun = false, now = new Date(), db = getDb() }: { dryRun?: boolean; now?: Date; db?: Executor } = {}): Promise<CopyReport> {
  const read = (name: string) => source.collection(name).find({}).toArray();
  const [userDocs, categoryDocs, brandDocs, productDocs, cartDocs, orderDocs, pendingDocs, chunkDocs] = await Promise.all(Object.values(COPIED).map(read));
  const report: CopyReport = { dryRun, tables: {}, notCopied: {} };
  const table = (name: keyof typeof COPIED, docs: Document[]): TableReport => (report.tables[name] = { source: docs.length, copied: 0, skipped: [], notes: [] });

  // People and the catalog.
  const userReport = table('users', userDocs!);
  const userRows = userDocs!.map((doc) => ({
    id: uuidFromObjectId(hexOf(doc._id)!),
    name: String(doc.name ?? '').trim(),
    email: String(doc.email ?? '').trim().toLowerCase(),
    // bcrypt hashes, as before: everyone signs in with the same password.
    password: String(doc.password ?? ''),
    profile: optional(doc.profile as string | undefined),
    isVerified: doc.isVerified === true,
    // Refresh tokens are kept, so a signed-in customer stays signed in across the move: their
    // next refresh swaps the old access token (with the ObjectId) for one with the new id.
    refreshTokens: Array.isArray(doc.refreshTokens) ? doc.refreshTokens.map(String) : [],
    role: doc.role === 'admin' ? 'admin' : 'user',
    pendingEmail: optional(doc.pendingEmail as string | undefined),
    pendingEmailOtpHash: optional(doc.pendingEmailOtpHash as string | undefined),
    pendingEmailExpiresAt: optional(doc.pendingEmailExpiresAt as Date | undefined),
    pendingEmailAttempts: optional(doc.pendingEmailAttempts as number | undefined),
    createdAt: dateOf(doc, 'createdAt'),
    updatedAt: dateOf(doc, 'updatedAt'),
  }));
  const userIds = new Set(userDocs!.map((doc) => hexOf(doc._id)!));

  const named = (docs: Document[]) =>
    docs.map((doc) => ({ id: uuidFromObjectId(hexOf(doc._id)!), name: String(doc.name ?? '').trim(), createdAt: dateOf(doc, 'createdAt'), updatedAt: dateOf(doc, 'updatedAt') }));
  const categoryReport = table('categories', categoryDocs!);
  const brandReport = table('brands', brandDocs!);
  const categoryIds = new Set(categoryDocs!.map((doc) => hexOf(doc._id)!));
  const brandIds = new Set(brandDocs!.map((doc) => hexOf(doc._id)!));

  const productReport = table('products', productDocs!);
  const productRows = productDocs!.flatMap((doc) => {
    const id = hexOf(doc._id)!;
    const category = hexOf(doc.category);
    const brand = hexOf(doc.brand);
    // Postgres requires both; MongoDB let a category or brand be deleted under its products.
    if (!category || !categoryIds.has(category)) return void productReport.skipped.push({ id, reason: 'its category no longer exists' }), [];
    if (!brand || !brandIds.has(brand)) return void productReport.skipped.push({ id, reason: 'its brand no longer exists' }), [];
    return [
      {
        id: uuidFromObjectId(id),
        name: String(doc.name ?? '').trim(),
        description: String(doc.description ?? ''),
        price: Number(doc.price ?? 0),
        images: Array.isArray(doc.images) ? doc.images.map(String) : [],
        stock: Math.max(0, Math.trunc(Number(doc.stock ?? 0))),
        categoryId: uuidFromObjectId(category),
        brandId: uuidFromObjectId(brand),
        createdAt: dateOf(doc, 'createdAt'),
        updatedAt: dateOf(doc, 'updatedAt'),
      },
    ];
  });
  const productIds = new Set(productRows.map((row) => row.id));

  // Carts: one per customer; lines whose product is gone are left out, as the cart showed them empty.
  const cartReport = table('carts', cartDocs!);
  let droppedLines = 0;
  const cartRows: Record<string, unknown>[] = [];
  const lineRows: Record<string, unknown>[] = [];
  for (const doc of cartDocs!) {
    const id = hexOf(doc._id)!;
    const user = hexOf(doc.user);
    if (!user || !userIds.has(user)) {
      cartReport.skipped.push({ id, reason: 'its customer no longer exists' });
      continue;
    }
    const cartId = uuidFromObjectId(id);
    cartRows.push({ id: cartId, userId: uuidFromObjectId(user), createdAt: dateOf(doc, 'createdAt'), updatedAt: dateOf(doc, 'updatedAt') });
    const byProduct = new Map<string, { id: string; quantity: number }>();
    for (const item of (doc.items ?? []) as Document[]) {
      const product = hexOf(item.product);
      const quantity = Math.trunc(Number(item.quantity ?? 0));
      if (!product || !productIds.has(uuidFromObjectId(product)) || quantity < 1) {
        droppedLines += 1;
        continue;
      }
      const productId = uuidFromObjectId(product);
      const line = byProduct.get(productId);
      if (line) line.quantity += quantity;
      else byProduct.set(productId, { id: uuidFromObjectId(hexOf(item._id) ?? derivedHex(id, productId)), quantity });
    }
    [...byProduct.entries()].forEach(([productId, line], position) => lineRows.push({ id: line.id, cartId, productId, quantity: line.quantity, position }));
  }
  if (droppedLines) cartReport.notes.push(`${droppedLines} cart line(s) left out: the product no longer exists`);

  // Orders keep their history; a deleted customer's order is kept without a user, as Postgres does.
  const orderReport = table('orders', orderDocs!);
  const item = (orderId: string) => (raw: Document, index: number): OrderItem => {
    const product = hexOf(raw.product);
    return {
      _id: uuidFromObjectId(hexOf(raw._id) ?? derivedHex(orderId, String(index))),
      product: product ? uuidFromObjectId(product) : String(raw.product ?? ''),
      name: String(raw.name ?? ''),
      price: Number(raw.price ?? 0),
      quantity: Math.trunc(Number(raw.quantity ?? 0)),
      ...(raw.image !== undefined ? { image: String(raw.image) } : {}),
    };
  };
  const address = (raw: unknown): ShippingAddress => {
    const { _id: _ignored, ...rest } = (raw ?? {}) as Record<string, unknown>;
    return rest as unknown as ShippingAddress;
  };
  let ordersWithoutUser = 0;
  const orderRows = orderDocs!.map((doc) => {
    const id = hexOf(doc._id)!;
    const user = hexOf(doc.user);
    const known = Boolean(user && userIds.has(user));
    if (!known) ordersWithoutUser += 1;
    return {
      id: uuidFromObjectId(id),
      userId: known ? uuidFromObjectId(user!) : null,
      items: ((doc.items ?? []) as Document[]).map(item(id)),
      subtotal: Number(doc.subtotal ?? 0),
      tax: Number(doc.tax ?? 0),
      shipping: Number(doc.shipping ?? 0),
      total: Number(doc.total ?? 0),
      status: doc.status ?? 'pending',
      paymentStatus: doc.paymentStatus ?? 'pending',
      paymentMethod: doc.paymentMethod ?? 'stripe',
      stripeSessionId: optional(doc.stripeSessionId as string | undefined),
      shippingAddress: address(doc.shippingAddress),
      paidAt: optional(doc.paidAt as Date | undefined),
      deliveredAt: optional(doc.deliveredAt as Date | undefined),
      createdAt: dateOf(doc, 'createdAt'),
      updatedAt: dateOf(doc, 'updatedAt'),
    };
  });
  if (ordersWithoutUser) orderReport.notes.push(`${ordersWithoutUser} order(s) kept without a customer: the account no longer exists`);

  // Checkouts still open (under 24 hours), so a payment made around the move still becomes an order.
  const pendingReport = table('pending_checkouts', pendingDocs!);
  const pendingRows = pendingDocs!.flatMap((doc) => {
    const id = hexOf(doc._id)!;
    const createdAt = dateOf(doc, 'createdAt');
    if (now.getTime() - createdAt.getTime() >= PENDING_CHECKOUT_LIFETIME_MS) return void pendingReport.skipped.push({ id, reason: 'expired' }), [];
    const user = hexOf(doc.user);
    return [
      {
        id: uuidFromObjectId(id),
        stripeSessionId: String(doc.stripeSessionId),
        userId: user && userIds.has(user) ? uuidFromObjectId(user) : null,
        items: ((doc.items ?? []) as Document[]).map(item(id)),
        shippingAddress: address(doc.shippingAddress),
        subtotal: Number(doc.subtotal ?? 0),
        tax: Number(doc.tax ?? 0),
        shipping: Number(doc.shipping ?? 0),
        total: Number(doc.total ?? 0),
        cartHash: optional(doc.cartHash as string | undefined),
        checkoutUrl: optional(doc.checkoutUrl as string | undefined),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + PENDING_CHECKOUT_LIFETIME_MS),
      },
    ];
  });

  // The store knowledge, with its embeddings: copying them saves re-embedding every chunk.
  const chunkReport = table('knowledge_chunks', chunkDocs!);
  const chunkRows = chunkDocs!.flatMap((doc) => {
    const embedding = Array.isArray(doc.embedding) ? doc.embedding.map(Number) : [];
    if (embedding.length !== 1024) return void chunkReport.skipped.push({ id: String(doc._id), reason: 'its embedding is not 1024 numbers' }), [];
    return [
      {
        id: String(doc._id),
        file: String(doc.file ?? ''),
        title: String(doc.title ?? ''),
        question: String(doc.question ?? ''),
        text: String(doc.text ?? ''),
        context: optional(doc.context as string | undefined),
        embedding,
        contentHash: String(doc.contentHash ?? ''),
        updatedAt: dateOf(doc, 'updatedAt'),
      },
    ];
  });

  // Everything else, counted so nothing is left out unseen.
  const copiedNames = new Set<string>(Object.values(COPIED));
  for (const { name } of await source.listCollections({}, { nameOnly: true }).toArray()) {
    if (!copiedNames.has(name) && !name.startsWith('system.')) report.notCopied[name] = await source.collection(name).countDocuments();
  }

  // The writes: one transaction, parents before the rows that point at them.
  try {
    await db.transaction(async (tx) => {
      await upsert(tx, users, users.id, userRows);
      await upsert(tx, categories, categories.id, named(categoryDocs!));
      await upsert(tx, brands, brands.id, named(brandDocs!));
      await upsert(tx, products, products.id, productRows);
      await upsert(tx, carts, carts.id, cartRows);
      // A copied cart's lines are replaced, so a line removed in MongoDB since the last run goes too.
      const cartIds = cartRows.map((row) => row.id as string);
      if (cartIds.length) await tx.delete(cartItems).where(inArray(cartItems.cartId, cartIds));
      await upsert(tx, cartItems, cartItems.id, lineRows);
      await upsert(tx, orders, orders.id, orderRows);
      await upsert(tx, pendingCheckouts, pendingCheckouts.id, pendingRows);
      await upsert(tx, knowledgeChunks, knowledgeChunks.id, chunkRows);

      // Check that every row is there before committing.
      const check = async (name: string, tbl: PgTable, idColumn: never, ids: string[], expected = ids.length) => {
        const [row] = ids.length ? await tx.select({ n: count() }).from(tbl).where(inArray(idColumn, ids)) : [{ n: 0 }];
        if ((row?.n ?? 0) !== expected) throw new CountMismatchError(`${name}: ${row?.n ?? 0} rows in Postgres, ${expected} expected`);
      };
      await check('users', users, users.id as never, userRows.map((r) => r.id));
      await check('categories', categories, categories.id as never, named(categoryDocs!).map((r) => r.id));
      await check('brands', brands, brands.id as never, named(brandDocs!).map((r) => r.id));
      await check('products', products, products.id as never, productRows.map((r) => r.id));
      await check('carts', carts, carts.id as never, cartIds);
      await check('cart lines', cartItems, cartItems.cartId as never, cartIds, lineRows.length);
      await check('orders', orders, orders.id as never, orderRows.map((r) => r.id));
      await check('pending checkouts', pendingCheckouts, pendingCheckouts.id as never, pendingRows.map((r) => r.id));
      await check('knowledge chunks', knowledgeChunks, knowledgeChunks.id as never, chunkRows.map((r) => r.id));

      if (dryRun) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }

  userReport.copied = userRows.length;
  categoryReport.copied = categoryDocs!.length;
  brandReport.copied = brandDocs!.length;
  productReport.copied = productRows.length;
  cartReport.copied = cartRows.length;
  orderReport.copied = orderRows.length;
  pendingReport.copied = pendingRows.length;
  chunkReport.copied = chunkRows.length;
  for (const [name, t] of Object.entries(report.tables)) {
    if (t.copied + t.skipped.length !== t.source) throw new CountMismatchError(`${name}: ${t.copied} copied and ${t.skipped.length} left out of ${t.source}`);
  }
  return report;
}

/** The report as the command prints it: counts, what was left out and why. */
export function renderReport(report: CopyReport): string {
  const lines = [report.dryRun ? 'Copy from MongoDB — dry run: checked, and nothing was written' : 'Copy from MongoDB — done'];
  for (const [name, t] of Object.entries(report.tables)) {
    lines.push(`  ${name.padEnd(18)} ${String(t.copied).padStart(6)} of ${t.source}`);
    for (const skip of t.skipped) lines.push(`      left out ${skip.id}: ${skip.reason}`);
    for (const note of t.notes) lines.push(`      ${note}`);
  }
  const others = Object.entries(report.notCopied);
  lines.push(
    others.length
      ? `Not copied (short-lived, rebuilt or the agent's): ${others.map(([name, n]) => `${name} ${n}`).join(', ')}`
      : 'Not copied: nothing else in the database',
  );
  return lines.join('\n');
}

// `npm run db:copy-from-mongo [-- --dry-run]`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const sourceUrl = process.env.MONGO_SOURCE_URL;
  if (!sourceUrl) {
    process.stderr.write('Set MONGO_SOURCE_URL to the MongoDB connection string (with the database name) and DATABASE_URL to the Postgres one.\n');
    process.exit(1);
  }
  const { MongoClient } = await import('mongodb');
  const { closeDb } = await import('../../src/db/client.js');
  const client = new MongoClient(sourceUrl);
  let code = 0;
  try {
    await client.connect();
    process.stdout.write(`${renderReport(await copyFromMongo(client.db(process.env.MONGO_SOURCE_DB || undefined), { dryRun }))}\n`);
  } catch (error) {
    process.stderr.write(`Copy failed, nothing was written: ${describeError(error)}\n`);
    code = 1;
  } finally {
    await client.close();
    await closeDb();
  }
  process.exit(code);
}
