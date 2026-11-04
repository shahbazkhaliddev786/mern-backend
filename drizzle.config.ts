// drizzle-kit (spec 023): `npm run db:generate` writes SQL migrations from src/db/schema into
// drizzle/; `npm run db:migrate` applies them. Migrations use the direct (unpooled) Neon URL when
// DIRECT_DATABASE_URL is set.
import 'dotenv-flow/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '' },
});
