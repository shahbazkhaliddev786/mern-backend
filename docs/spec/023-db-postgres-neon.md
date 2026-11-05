# 023 — Move the store and the agent to PostgreSQL on Neon (Drizzle + pgvector)

| | |
|---|---|
| **Status** | In progress |
| **Milestone** | Platform: before launch (M7 launch becomes spec 024) |
| **Created** | 2026-11-04 |
| **Updated** | 2026-11-05 |
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

- [x] **1. Foundation** (`9888fee`): Drizzle and drizzle-kit; `src/db/client.ts`; the schema; the first migration; local `pgvector` container; per-file test schemas; `npm run db:generate`, `db:migrate` and `db:studio`
- [x] **2. Store data** (`42e60cf`): every model and service on Drizzle; the API's response shapes kept; the store's tests ported
- [x] **3. Agent stores** (`1aa8d7a`): the checkpointer, claims, limits, feedback and samples; the agent's tests and the safety gate ported
- [x] **4. Knowledge search** (`bde67cb`): `knowledge_chunks` on pgvector + full-text; the ingest and retrieval ported; the retrieval tests ported
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

_None — resolved 2026-11-04, see the decision log._

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-11-04 | Move from MongoDB to PostgreSQL on Neon, with Drizzle ORM and pgvector | Owner's decision |
| 2026-11-04 | Work happens on the `db-migration` branch, created from `main` at `4a334c8` | Owner's request |
| 2026-11-04 | This spec is 023, before launch; launch becomes 024 | The launch has to run on the new database |
| 2026-11-04 | Approved with the defaults: UUID ids with responses keeping `_id`; the MongoDB log transport dropped; `expires_at` with cleanup on write plus `db:cleanup`; staged commits on `db-migration` then one pull request; the `pg` driver with Neon's pooled URL | Owner's choice |
| 2026-11-04 | Existing data: the one-time copy script is built and dry-run against a Neon branch; running it on production is the owner's call | Whether the live store holds real customers or orders wasn't answered, and the script is the safe default either way |
| 2026-11-04 | Test files each get their own database, cloned from a template the migrations already ran on, instead of a schema each | A clone is a fast copy, and the migrations, pgvector and Drizzle's journal stay in `public` as they are in production |
| 2026-11-04 | Locally: Postgres 16 with pgvector 0.6; CI: `pgvector/pgvector:pg17` | Docker Hub refused the image here (rate limit); the schema uses nothing that differs between 16 and 17 |
| 2026-11-04 | The migrations stay one init migration, regenerated while `db-migration` is unmerged | No database outside the tests has run them |
| 2026-11-04 | `sku` is optional | The Mongoose schema never stored one, and products are created without it |
| 2026-11-04 | Deleting an account keeps its orders, without a user; its cart, pending checkouts and uploads go with it | As in Mongo, where orders kept their history; Postgres now cleans up the rest |
| 2026-11-04 | A category or brand that products still use can't be deleted (a clear error); a deleted product leaves every cart | Mongo allowed both and left records pointing at nothing |
| 2026-11-04 | `getUserById` returns the user without the password or tokens | The Mongo service returned the whole document; every caller used only the safe fields |
| 2026-11-04 | Database errors never reach a client; logs get the error code and the server's message | Drizzle's error messages include the SQL and its values, which can be a password hash or a token |
| 2026-11-04 | `DATABASE_URL` is Postgres from stage 2; MongoDB reads `MONGODB_URL` until stage 5 removes it | The store moved first, while the agent's stores, sessions and logs are still on MongoDB |
| 2026-11-04 | Postgres tracing (`instrumentation-pg`) comes in stage 2, not 5 | The checkout trace (spec 017) has to keep reaching the database |
| 2026-11-04 | Safety case 3 checks only what the tools returned | An all-digit order-number suffix could appear in the attacker's own message (CI run #33) |
| 2026-11-05 | `npm run db:migrate` also runs the checkpointer's setup | PostgresSaver keeps its own tables and needs its setup run once; one command then prepares a database, and test templates get them too |
| 2026-11-05 | One `rate_limits` table for every limiter, created by the migration | No request has to create a table; each limiter's key prefix keeps its counters apart |
| 2026-11-05 | `@langchain/langgraph-checkpoint` moves to 1.2.x; the MongoDB checkpointer package is removed now, not in stage 5 | The Postgres checkpointer needs 1.2 (langgraph allows it), and nothing uses the Mongo one any more |
| 2026-11-05 | Reads skip expired records before the cleanup exists | The TTL indexes removed them; an expired record should never be judged, listed or reused |
| 2026-11-05 | The online-evals job's `ONLINE_EVALS_DATABASE_URL` becomes a Neon role allowed only on `agent_turn_samples` and `agent_feedback` | The same limited access it had on MongoDB; the owner sets it up when online evals are wanted |
| 2026-11-05 | Migrations read `DATABASE_URL_UNPOOLED`, the name Vercel's Neon integration gives the direct connection; `DIRECT_DATABASE_URL` is gone | The owner's database came from that integration; nothing had set the old name |
| 2026-11-05 | The connection URL's `sslmode=require` becomes `verify-full`, and `channel_binding=require` becomes `pg`'s `enableChannelBinding` (`e23c3d4`) | `pg` already checked certificates fully and warned on every start; it ignores libpq's channel binding setting. Channel binding was checked against a local TLS server with RSA and ECDSA certificates |
| 2026-11-05 | The knowledge's meaning and word searches stay two queries, run side by side, instead of one | The word search runs while Voyage embeds the question, and the retrieval code keeps the seams its tests use |
| 2026-11-05 | The word search matches any of the question's words (`plainto_tsquery` with OR), ranked by `ts_rank_cd` | As Atlas's text search did; matching every word misses natural questions |
| 2026-11-05 | Lexical floor (fake embedder): 90% of the goldens on Postgres, 93% on Atlas | The one difference ("get in touch") shares no word with its answer; it was in Atlas's top 5 by the order of tied scores. The real embedder is judged by `eval:knowledge` |
| 2026-11-05 | `npm run agent:setup` is removed, and CI's MongoDB services go in stage 4 | The migration creates the search indexes, and no test needs MongoDB any more |
