// The database (spec 023): PostgreSQL on Neon through Drizzle, over one small `pg` pool. On Vercel
// the pool is reused across warm starts, as the Mongo connection was. Use Neon's pooled
// connection string here; migrations use the direct one (DIRECT_DATABASE_URL) when it's set.

import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import config from '../config/config.js';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let db: Db | null = null;

const newPool = (connectionString: string) =>
  new pg.Pool({
    connectionString,
    // A serverless function serves one request at a time; Neon's pooler does the rest.
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

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
