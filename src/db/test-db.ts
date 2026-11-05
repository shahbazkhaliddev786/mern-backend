// Test databases (spec 023). Every test file gets its own database, cloned from a template that
// already has the migrations applied: fast, and isolated the way each Mongo test file had its own
// database. The template's name carries a hash of the migrations, so changing them rebuilds it.
// Needs TEST_DATABASE_URL (any database on the server; e.g. postgres://postgres@127.0.0.1:5432/postgres).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { closeDb, getPool, useDatabase } from './client.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

/** What a template is built from: our migrations, and the checkpointer version that adds its tables. */
function migrationsHash(): string {
  const hash = crypto.createHash('sha256');
  for (const file of fs.readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).sort()) {
    hash.update(file).update(fs.readFileSync(path.join(MIGRATIONS_FOLDER, file)));
  }
  const checkpointer = createRequire(import.meta.url)('@langchain/langgraph-checkpoint-postgres/package.json') as { version: string };
  hash.update(`checkpointer@${checkpointer.version}`);
  return hash.digest('hex').slice(0, 10);
}

/** Runs `body` holding a server-wide lock, so parallel test files don't race on the template. */
async function withAdmin<T>(body: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: withDb(TEST_DATABASE_URL, 'postgres') });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(42023)');
    return await body(admin);
  } finally {
    await admin.query('SELECT pg_advisory_unlock(42023)').catch(() => {});
    await admin.end();
  }
}

export interface TestDatabase {
  url: string;
  /** Closes the app's pool and drops the database. */
  drop: () => Promise<void>;
}

/** A fresh, migrated database for one test file; the app's `getDb()` points at it. */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const template = `aljo_tpl_${migrationsHash()}`;
  const name = `aljo_t_${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${crypto.randomBytes(3).toString('hex')}`;
  await withAdmin(async (admin) => {
    const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template])).rowCount;
    if (!exists) {
      await admin.query(`CREATE DATABASE "${template}"`);
      await runMigrations(withDb(TEST_DATABASE_URL, template));
    }
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  });
  const url = withDb(TEST_DATABASE_URL, name);
  await useDatabase(url);
  return {
    url,
    drop: async () => {
      await closeDb();
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

/**
 * For concurrency tests: runs `setup` in a transaction on a connection of its own and keeps the
 * transaction open, so whatever it locked stays locked. `releaseWhen(n)` waits until `n` other
 * connections are stuck waiting on a lock, then rolls back. That makes a race happen every time.
 */
export async function holdLocks(url: string, setup: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('BEGIN');
  await setup(client);
  return {
    releaseWhen: async (waiting: number, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      try {
        for (;;) {
          const { rows } = await getPool().query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          if (rows[0].n >= waiting) break;
          if (Date.now() > deadline) throw new Error(`Only ${rows[0].n} of ${waiting} connections reached the lock`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
    },
  };
}
