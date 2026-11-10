# Aljo Store — backend

Express 5 + TypeScript API for the Aljo Store, with the AI shopping assistant (`src/agent`). Data lives in **PostgreSQL on Neon**, through **Drizzle ORM**; the store-knowledge search uses **pgvector** and Postgres full-text search ([spec 023](./docs/spec/023-db-postgres-neon.md)).

## Local setup

1. `npm ci`
2. A PostgreSQL 16+ server with the `vector` extension available (the `pgvector/pgvector:pg17` Docker image, or a Neon branch).
3. Copy `.env.example` to `.env` and set at least `DATABASE_URL`, `JWT_SECRET`, `REFRESH_TOKEN_SECRET`, `SESSION_SECRET` and the Cloudinary keys.
4. `npm run db:migrate` creates the tables, the indexes (including the search indexes) and the agent memory's tables.
5. `npm run dev` starts the API on `PORT` (4000).

**Tests:** `npm test`. The database tests need `TEST_DATABASE_URL` (any database on a server with pgvector, e.g. `postgres://postgres@127.0.0.1:5432/postgres`): each test file clones its own database, and drops it afterwards. Without it they skip, except in CI, where they fail. The safety gate is `npm run eval:safety`.

## Deploy (Vercel + Neon)

The Neon integration in Vercel sets the database variables:
- **`DATABASE_URL`:** the pooled connection, which the app uses.
- **`DATABASE_URL_UNPOOLED`:** the direct connection, which the migrations use.

Then:
- **Run the migrations:** `npm run db:migrate` against the database, with `DATABASE_URL_UNPOOLED` set, before the first deploy and after any schema change.
- **Set `CRON_SECRET`** (any long random string) for Production. Vercel Cron calls `GET /api/v1/internal/cleanup` daily (`vercel.json`), which deletes expired records; it refuses every call while the secret is unset.
- **Load the store knowledge** with `npm run agent:ingest` (it needs the Anthropic and Voyage keys) whenever `knowledge/` changes. A copy from MongoDB brings existing chunks along.

## Scripts

| Script | What it does |
|---|---|
| `db:generate` | Writes a SQL migration in `drizzle/` from the schema in `src/db/schema` |
| `db:migrate` | Applies the migrations and the checkpointer's setup |
| `db:studio` | Opens Drizzle Studio |
| `db:cleanup` | Deletes expired records now (the same sweep the daily cron runs) |
| `db:copy-from-mongo` | The one-time copy of the old MongoDB data (below) |
| `agent:ingest` | Loads `knowledge/` into the store-knowledge search (`-- --dry-run` lists the chunks) |
| `eval:safety`, `eval:agent`, `eval:knowledge`, `eval:online` | The agent's eval suites ([`docs/shopping-agent/evals.md`](./docs/shopping-agent/evals.md)) |

## The one-time move from MongoDB

The store ran on MongoDB until spec 023. To bring its data over:
1. Create a branch of the Neon database.
2. Run `npm run db:migrate` against the branch.
3. Do a dry run:
   ```
   MONGO_SOURCE_URL="mongodb+srv://…/aljo-store" DATABASE_URL="<Neon branch URL>" npm run db:copy-from-mongo -- --dry-run
   ```

The dry run checks everything, prints counts per table and lists anything it left out with the reason, then writes nothing. Without `--dry-run`, the copy is one transaction, and running it again updates rather than duplicates. Run it against production at switch-over. Delete `scripts/copy-from-mongo/` once the move is done.

## Docs

- [`docs/spec/`](./docs/spec/README.md): the specs, one per change, with their decisions
- [`docs/shopping-agent/`](./docs/shopping-agent/architecture.md): the shopping assistant's design
- [`knowledge/`](./knowledge/README.md): the store-knowledge sources
