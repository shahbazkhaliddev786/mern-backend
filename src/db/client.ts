// The database (spec 023): PostgreSQL on Neon through Drizzle, over one small `pg` pool. On Vercel
// the pool is reused across warm starts, as the Mongo connection was. DATABASE_URL is Neon's pooled
// connection string; migrations use the direct one (DATABASE_URL_UNPOOLED) when it's set.

import pg from 'pg';
import { DrizzleQueryError } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { pgConfig } from './connection.js';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;
/** A transaction; services that take one can run inside a caller's transaction or on their own. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

let pool: pg.Pool | null = null;
let db: Db | null = null;

const newPool = (connectionString: string) => {
  const created = new pg.Pool({
    ...pgConfig(connectionString),
    // A serverless function serves one request at a time; Neon's pooler does the rest.
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle connection the server closed (Neon scales to zero) must not crash the process.
  created.on('error', (error) => logger.warn('Database connection lost', { error: error.message }));
  return created;
};

export function getPool(): pg.Pool {
  if (!pool) {
    if (!config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    pool = newPool(config.DATABASE_URL);
  }
  return pool;
}

export function getDb(): Db {
  db ??= drizzle(getPool(), { schema });
  return db;
}

/** For tests and scripts: point the app at another database. */
export async function useDatabase(connectionString: string): Promise<void> {
  await closeDb();
  pool = newPool(connectionString);
}

export async function closeDb(): Promise<void> {
  const closing = pool;
  pool = null;
  db = null;
  await closing?.end();
}

/** The Postgres error code behind a failed query (Drizzle wraps the driver's error), if any. */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

export const isUniqueViolation = (error: unknown): boolean => pgErrorCode(error) === '23505';

/**
 * An error from a database query. Its message holds the SQL and the values sent with it (which can
 * be a password hash or a token), so it never goes to a client or a log line as it is.
 */
export const isDbError = (error: unknown): error is DrizzleQueryError => error instanceof DrizzleQueryError;

/** An error's message for a log line: a database error by its code and the server's own message only. */
export function describeError(error: unknown): string {
  if (isDbError(error)) {
    const code = pgErrorCode(error);
    return `Database error${code ? ` ${code}` : ''}: ${error.cause instanceof Error ? error.cause.message : 'query failed'}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** An error's message for a client: never a database error's. */
export function clientErrorMessage(error: unknown, fallback: string): string {
  if (isDbError(error)) return fallback;
  return (error instanceof Error && error.message) || fallback;
}
