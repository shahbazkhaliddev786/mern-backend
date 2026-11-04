// Applies the SQL migrations in drizzle/ (spec 023). `npm run db:migrate` runs it against
// DIRECT_DATABASE_URL (or DATABASE_URL); the test helper runs it to build its template database.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

export const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}

// `npm run db:migrate`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: config } = await import('../config/config.js');
  const url = process.env.DIRECT_DATABASE_URL || config.DATABASE_URL;
  runMigrations(url)
    .then(() => {
      process.stdout.write('Migrations applied.\n');
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
