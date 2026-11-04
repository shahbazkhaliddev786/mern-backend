// Test databases (spec 023). Every test file gets its own database, cloned from a template that
// already has the migrations applied: fast, and isolated the way each Mongo test file had its own
// database. The template's name carries a hash of the migrations, so changing them rebuilds it.
// Needs TEST_DATABASE_URL (any database on the server; e.g. postgres://postgres@127.0.0.1:5432/postgres).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { closeDb, useDatabase } from './client.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

function migrationsHash(): string {
  const hash = crypto.createHash('sha256');
  for (const file of fs.readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).sort()) {
    hash.update(file).update(fs.readFileSync(path.join(MIGRATIONS_FOLDER, file)));
  }
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
