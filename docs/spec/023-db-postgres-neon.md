# 023 — Move the store and the agent to PostgreSQL on Neon (Drizzle + pgvector)

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | Platform: before launch (M7 launch becomes spec 024) |
| **Created** | 2026-11-04 |
| **Updated** | 2026-11-04 |
| **Closed by** | — |
| **Repo** | `mern-backend` (branch `db-migration`); `mern-frontend` only if the open questions need it |

## Goal

The Aljo Store backend runs on **PostgreSQL on Neon**, through **Drizzle ORM**. That covers:
- the store's own data
- the shopping agent's memory, claims, limits, feedback and samples
- the store-knowledge search, on **pgvector** and Postgres full-text search

MongoDB is no longer needed. Every API response keeps its current shape, so the frontend and the agent behave exactly as before, and every test and the safety gate pass against Postgres.

## Context

**The decision:** the owner chose PostgreSQL on Neon with Drizzle and pgvector (2026-11-04). This spec is how we get there.

**What depends on MongoDB today** (`main` at `4a334c8`):

| Area | Today | Where |
|---|---|---|
| Store data | 9 Mongoose models: user, OTP, product, category, brand, cart, order, pending checkout, pending upload. Services use `populate`, `findOneAndUpdate` and aggregates (about 40 call sites) | `src/models/*`, `src/services/*`; 30 source files import `mongoose` |
| Connection | `connectDB()`, with the connection cached for serverless warm starts | `src/services/db.service.ts` |
| Agent memory | `@langchain/langgraph-checkpoint-mongodb`, 30-day TTL | `src/agent/checkpointer.ts` |
| Confirmation claims | `confirm_claims` collection, unique `_id`, TTL | `checkpointer.ts` |
| Per-user limits | `RateLimiterMongo` (`rate-limiter-flexible`) | `src/agent/limits.ts`, `src/config/rate.limiter.ts` |
| Feedback, turn samples | `agent_feedback`, `agent_turn_samples`, with TTL indexes | `src/agent/online-evals.ts` |
| Store-knowledge search | `knowledge_chunks` with Atlas `$vectorSearch` + `$search`, fused, then Voyage rerank | `src/agent/rag/*` |
| Login sessions | `connect-mongo` | `src/loaders/express.ts` |
| Logs | `winston-mongodb` transport | `src/utils/logger.ts` |
| Ids | 24-character ObjectIds, checked in 26 places (e.g. the tools' `OBJECT_ID_PATTERN`) | backend only |
| Tests and CI | 10 database test files; CI runs `mongo:7` and `mongodb-atlas-local` | `*.mongo.test.ts`, `.github/workflows/ci.yml` |

**The frontend** never checks the id format, but it reads `_id` from API responses in about 96 places. So the API keeps the `_id` field name, whatever the id values become.

**Postgres equivalents that already exist:**
- `@langchain/langgraph-checkpoint-postgres` (`PostgresSaver`)
- `RateLimiterPostgres` in the same `rate-limiter-flexible`
- `connect-pg-simple` for sessions
- `pgvector` (on Neon by default)
- Postgres full-text search (`tsvector`, `ts_rank`)

## Scope

**In:**
- **Drizzle setup:** the schema for every model and agent table, `drizzle-kit` migrations committed as SQL, and the database connection.
- **The rewrite:** every service and the agent stores move from Mongoose to Drizzle, with the same behaviour and the same API responses.
- **Knowledge search on Postgres:** pgvector (HNSW, cosine) plus full-text search, fused as before, then the Voyage rerank as before.
- **Supporting pieces:**
  - Postgres-backed sessions and limits
  - the logs decision (open question 3)
  - expiry for records that used TTL indexes (open question 4)
- **Tests and CI:**
  - tests and the safety gate run on a local `pgvector` Postgres container
  - CI replaces the two MongoDB services with one Postgres service
- **Moving existing data** from MongoDB to Neon (open question 1).
- **Docs:** setup, `.env.example`, and the design docs that name MongoDB.

**Out:**
- **Changes to API shapes or frontend behaviour,** unless open question 2 needs a small frontend change.
- **New features,** and any other changes to cart, order or user flows.
- **Launch work** (spec 024).

## Design

**Connection** — `src/db/client.ts`:
- `drizzle-orm/node-postgres` over one `pg` Pool, using Neon's **pooled** connection string (`DATABASE_URL`).
- The pool is cached across serverless warm starts, as `connectDB()` does today, and kept small (`max` about 5).
- One driver everywhere (production, tests, CI), and the same `pg` Pool that `PostgresSaver`, `RateLimiterPostgres` and `connect-pg-simple` take. Open question 6.

**Schema** — `src/db/schema/*.ts`, one file per area:
- **Store tables:** `users`, `otps`, `categories`, `brands`, `products`, `carts` + `cart_items`, `orders` + `order_items`, `pending_checkouts`, `pending_uploads`.
  - **Arrays and embedded documents** become child tables (cart items, order items) or `jsonb` (product images, the shipping address snapshot), whichever matches how they're read.
  - **Money** is `numeric(10,2)` read as a number (Drizzle `mode: 'number'`), so prices stay exact in the database and look the same in the API.
  - **Timestamps** are `timestamptz`, with `created_at` / `updated_at` kept up to date.
  - **Indexes** mirror the current Mongoose ones: product category, brand and SKU, plus a full-text index for product search. Uniqueness carries over (user email, pending-checkout session id, cart per user).
- **Agent tables:**
  - **checkpoints:** `PostgresSaver`'s own tables, created by its `setup()`
  - **`agent_confirm_claims`:** `interrupt_id` primary key, plus `thread` and `created_at`
  - **limits:** `RateLimiterPostgres`'s own tables
  - **`agent_feedback`:** with a unique constraint on (`user_id`, `reply_id`)
  - **`agent_turn_samples`**
  - **`knowledge_chunks`:** `embedding vector(1024)`, a generated `tsvector` column, an HNSW index (`vector_cosine_ops`) and a GIN index
- **Ids:** open question 2. Whatever the choice, responses keep the `_id` field name, mapped in one place in each service's output, so the frontend doesn't change.

**Services** — rewritten one by one behind their current function signatures:
- Each controller, and each agent tool that calls a service, keeps working unchanged.
- `populate` becomes joins.
- Read-modify-write updates (cart quantities, stock) become single SQL statements or transactions. The cart and checkout paths get transactions where Mongoose relied on single-document atomicity.

**Store-knowledge search** — `src/agent/rag/retrieve.ts`:
1. One SQL query takes the top N by cosine distance (`<=>`) and the top N by `ts_rank`.
2. The two lists are fused with reciprocal-rank fusion, as today.
3. Voyage reranks the result, unchanged.

Retrieval returns the same shape, so `ask_store_knowledge` and the knowledge evals don't change. The thresholds (`KNOWLEDGE` in `config.ts`) are re-checked by the knowledge goldens once a key is available.

**Expiry** — open question 4. Postgres has no TTL, so records that relied on one need another way out: checkpoints, claims, feedback, samples, OTPs, pending checkouts and pending uploads.

**Tests and CI:**
- **Locally:** one Docker container, `pgvector/pgvector:pg17`, replaces `spike-mongo` and `atlas-local`.
- **Test isolation:** every database test file gets its own schema (or database), created from the migrations and dropped after, as each Mongo test uses its own database today.
- **Variables:** `MONGO_URL` / `ATLAS_URL` become `TEST_DATABASE_URL`.
- **The CI guard:** fail rather than skip in CI when the variable is missing (spec 019) still applies.
- **CI:** `checks` runs one `pgvector` service; `judged-evals` uses it too.

**Moving existing data** — open question 1. If chosen, `scripts/migrate-from-mongo.ts`:
- reads every MongoDB collection, maps ids and references, and writes to Neon in one transaction per table group
- prints counts, which are checked against the source
- runs once, against a Neon branch first; Neon branches make a dry run free

**Delivery** — open question 5.

## Tasks

- [ ] **1. Foundation:** Drizzle and drizzle-kit; `src/db/client.ts`; the schema; the first migration; local `pgvector` container; per-file test schemas; `npm run db:generate`, `db:migrate` and `db:studio`
- [ ] **2. Store data:** every model and service on Drizzle; the API's response shapes kept; the store's tests ported
- [ ] **3. Agent stores:** the checkpointer, claims, limits, feedback and samples; the agent's tests and the safety gate ported
- [ ] **4. Knowledge search:** `knowledge_chunks` on pgvector + full-text; the ingest and retrieval ported; the retrieval tests ported
- [ ] **5. The rest:** sessions, logs and expiry; MongoDB packages removed; CI moved to the Postgres service
- [ ] **6. Data:** the move script and a dry run on a Neon branch (if chosen)
- [ ] **7. Docs:** `.env.example`, setup, the design docs (`architecture.md`, `tech-stack.md`, `phases.md`) and the spec index

## Acceptance criteria

- [ ] No `mongoose`, `mongodb`, `connect-mongo`, `winston-mongodb` or `langgraph-checkpoint-mongodb` left in `package.json` or `src/`.
- [ ] Every API response has the same fields and types as before, with a contract test per route group on the main endpoints.
- [ ] `npm test` passes against Postgres, with no database test skipped in CI.
  - The safety gate still reads 17 pass, 1 n/a.
  - The oracle agent suite (spec 020) passes all 51 cases.
- [ ] Knowledge retrieval returns the expected chunks for the existing retrieval tests. The knowledge evals' scores, once a key is available, are recorded and compared with Atlas.
- [ ] Records that expired by TTL still expire — test.
- [ ] **Checks:** lint 0 errors, build, CI green on `db-migration`.
- [ ] **Data (if chosen):** the move script's counts match on a Neon branch dry run.

## Test plan

- **The existing suites** (unit, HTTP, the safety gate, the oracle agent suite) are the regression net. They're ported to Postgres, not rewritten.
- **New tests:**
  - the response-shape contract tests
  - transactions on cart and checkout under concurrent requests
  - expiry
  - the hybrid search query
- **Manual:** the full store flow against a Neon branch through the Vercel preview of `db-migration`: browse, cart, checkout with Stripe test mode, admin.

## Open questions

1. **Existing production data.**
   - **Recommended:** if the live store has real customers or orders, copy them with the one-time script, dry-run on a Neon branch first.
   - If it only holds test data, start fresh with the catalog seeded.
   - Which is it?
2. **Ids.**
   - **Recommended:** UUIDs (`gen_random_uuid()`) for every table, keeping the `_id` field name in responses so the frontend doesn't change.
   - The cost is that old links with 24-character ids (e.g. `/products/<id>`) stop working, which only matters if those links are already shared.
   - **Alternative:** a text primary key that keeps copied rows' existing ids, with new rows getting UUIDs. That mixes two formats.
3. **Logs.**
   - **Recommended:** drop the database log transport. Vercel's logs and the traces (spec 017) already cover it, and logging into the app's own database adds load and cost.
   - **Alternative:** a `logs` table.
4. **Expiry without TTL indexes.**
   - **Recommended:** every table that expired by TTL gets an `expires_at` column. Expired rows are deleted:
     - a little at a time on the write paths (a bounded `DELETE … WHERE expires_at < now() LIMIT 100`)
     - plus `npm run db:cleanup`, which the existing daily CI job runs once its secret is set
   - Old agent checkpoints are pruned by their timestamp (30 days, as now).
5. **Delivery.**
   - **Recommended:** the seven stages above, as commits on `db-migration`, each leaving the suite green. Until a stage lands, its tests still run against MongoDB.
   - One pull request into `main` at the end, after the Neon-branch check, and nothing merged half-done.
6. **Database driver.**
   - **Recommended:** `pg` (node-postgres) with Neon's pooled connection string, the same in production, tests and CI. `PostgresSaver`, `RateLimiterPostgres` and `connect-pg-simple` all expect it.
   - **Alternative:** Neon's own serverless driver. It's slightly faster to connect cold, but needs a second driver for tests and for those libraries.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-11-04 | Move from MongoDB to PostgreSQL on Neon, with Drizzle ORM and pgvector | Owner's decision |
| 2026-11-04 | Work happens on the `db-migration` branch, created from `main` at `4a334c8` | Owner's request |
| 2026-11-04 | This spec is 023, before launch; launch becomes 024 | The launch has to run on the new database |
