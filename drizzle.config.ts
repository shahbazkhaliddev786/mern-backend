// drizzle-kit (spec 023): `npm run db:generate` writes SQL migrations from src/db/schema into
// drizzle/; `npm run db:migrate` applies them. drizzle-kit uses Neon's direct (unpooled) URL when
// DATABASE_URL_UNPOOLED is set, as Vercel's Neon integration names it.
import 'dotenv-flow/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '' },
});
