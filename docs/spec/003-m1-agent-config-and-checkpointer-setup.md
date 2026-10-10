# 003 — Agent config and checkpointer setup

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M1 — Spikes & foundations ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |

## Goal

The backend knows the agent's settings, keeps booting without them, and has a one-command way to prepare a database for the agent. This is the first agent code under `src/`: `src/agent/config.ts` and `src/agent/checkpointer.ts`, which M2 builds on.

## Context

- [`phases.md`](../shopping-agent/phases.md) M1 item 5: add `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY` and `LANGSMITH_*`, and remove the Gemini and Redis chat-memory entries ([`reconciliation.md`](../shopping-agent/reconciliation.md) Gap 18).
- Spec 002 decided: the checkpointer uses the app's mongoose client; checkpoints expire after 30 days; `setup()` runs once per environment, not per request; a `confirm_claims` collection with the same TTL backs the confirm guard.
- **Today's `.env.example`** has an agent section from an earlier design: `GEMINI_API_KEY` (twice), `LANGCHAIN_TRACING_V2` / `LANGCHAIN_API_KEY` / `LANGCHAIN_PROJECT`, `MOCK_EVAL`, `TYPESENSE_*`, and `REDIS_*` / `CHAT_SESSION_TTL_SECONDS` / `CHAT_MAX_MESSAGES`. No code reads any of them (`grep` over `src/` finds none). `src/config/config.ts` has no agent settings.

## Scope

**In:**
- Agent environment variables in `src/config/config.ts` and `.env.example`; the stale agent block removed.
- `src/agent/config.ts`: the agent's settings in one place — models and effort from the design docs as code constants, secrets and switches from the environment — with a check that fails clearly when the agent is switched on but misconfigured.
- `src/agent/checkpointer.ts`: builds the `MongoDBSaver` on the app's mongoose connection with the 30-day TTL.
- `npm run agent:setup`: connects to `DATABASE_URL`, runs `checkpointer.setup()` and creates the `confirm_claims` TTL index. Safe to run repeatedly.
- Unit tests for the config check.

**Out:**
- Any graph, tool, route or model call (M2).
- Store variables in `.env.example` (Cloudinary, auth, email, Stripe, support) — untouched.
- `TYPESENSE_*`: removed from `.env.example` because product search is Mongo-only in v1; re-added with Typesense if evals call for it ([`architecture.md`](../shopping-agent/architecture.md) §6). The `typesense` package stays installed.

## Design

**Environment variables** (`config.ts` reads them; `.env.example` documents them):

| Variable | Default | Used for |
|---|---|---|
| `AGENT_ENABLED` | `false` | Master switch. While false, the chat endpoint (M2) answers 503 and nothing below is required. Also the production kill switch |
| `ANTHROPIC_API_KEY` | — | Claude (required when enabled) |
| `VOYAGE_API_KEY` | — | Embeddings and rerank for store knowledge (required from M5; optional before) |
| `LANGSMITH_TRACING` | `false` | LangSmith tracing on/off |
| `LANGSMITH_API_KEY` | — | Required when `LANGSMITH_TRACING=true` |
| `LANGSMITH_PROJECT` | `aljo-store-agent` | LangSmith project name |

LangChain reads `LANGSMITH_*` from the environment itself; `config.ts` reads them too so the check below can catch a missing key.

**`src/agent/config.ts`:**

```ts
export const AGENT_MODELS = {
  agent: 'claude-sonnet-5-5',
  escalation: 'claude-opus-5-5',
  queryRewrite: 'claude-haiku-5-5',
} as const;
export const AGENT_EFFORT = { agent: 'low', escalation: 'medium', queryRewrite: 'low' } as const; // starting points; tuned by evals (tech-stack.md Layer 3)
export const STEP_BUDGET = 8;                    // reconciliation.md Gap 4
export const CHECKPOINT_TTL_SECONDS = 2_592_000; // 30 days, spec 002

export function getAgentConfig(env = process.env): AgentConfig  // reads and checks the variables above
export class AgentConfigError extends Error                       // lists every missing variable at once
```

- `getAgentConfig()` is called lazily (by the M2 route), never at import time, so the store boots and its tests run without agent variables.
- With `AGENT_ENABLED=true`: missing `ANTHROPIC_API_KEY` → `AgentConfigError`; `LANGSMITH_TRACING=true` without `LANGSMITH_API_KEY` → `AgentConfigError`. All problems are reported in one error.
- Model IDs and effort are constants, not environment variables: changing a model changes behaviour and must go through evals (M7), not a dashboard edit.

**`src/agent/checkpointer.ts`:**

```ts
export function createCheckpointer(connection = mongoose.connection): MongoDBSaver
```

- Uses `connection.getClient()` (cast to the checkpointer's `MongoClient` type — spec 002 showed driver 7 works at runtime) and `connection.db.databaseName`, with `ttl: CHECKPOINT_TTL_SECONDS`.
- Collections keep the library defaults (`checkpoints`, `checkpoint_writes`).
- Requires an open connection; throws a clear error if `connectDB()` hasn't run.

**`npm run agent:setup`** → `tsx src/agent/setup.ts`:
1. `connectDB()` against `DATABASE_URL`.
2. `createCheckpointer().setup()` — query indexes plus TTL indexes on both collections.
3. `confirm_claims`: TTL index on `createdAt` (`expireAfterSeconds: CHECKPOINT_TTL_SECONDS`). The unique key is the interrupt id as `_id`, so no extra unique index is needed.
4. Prints the resulting indexes and exits. Run once per environment (local, preview, production) with that environment's `DATABASE_URL`; re-running changes nothing.

## Tasks

- [ ] `config.ts`: add the six variables
- [ ] `.env.example`: replace the stale agent block with the documented one
- [ ] `src/agent/config.ts` with `getAgentConfig()` and the constants
- [ ] `src/agent/checkpointer.ts`
- [ ] `src/agent/setup.ts` + `agent:setup` script in `package.json`
- [ ] `src/agent/config.test.ts`
- [ ] Run `agent:setup` twice against the local MongoDB 7 and record the indexes
- [ ] Update `phases.md` §0 and the spec index

## Acceptance criteria

- [ ] With no agent variables set, the server boots and `npm test` passes — the existing 51 tests plus the new ones
- [ ] `getAgentConfig()` returns the settings when `AGENT_ENABLED` is false or everything required is set, and throws one `AgentConfigError` listing every missing variable otherwise — unit tests
- [ ] `npm run agent:setup` creates TTL indexes (2,592,000 s) on `checkpoints`, `checkpoint_writes` and `confirm_claims`, and a second run succeeds with the same indexes — checked against local MongoDB 7, output recorded in Results
- [ ] `.env.example` has no `GEMINI_*`, `REDIS_*`, `CHAT_*`, `LANGCHAIN_*`, `MOCK_EVAL` or `TYPESENSE_*` entries, and documents every variable in the table above — checked with `grep`
- [ ] `npm run lint` (0 errors) and `npm run build` pass

## Test plan

- Unit (`src/agent/config.test.ts`): disabled with nothing set; enabled with everything set; enabled without the Anthropic key; tracing on without the LangSmith key; both missing at once (one error, two names).
- Integration (manual, recorded): `DATABASE_URL=mongodb://127.0.0.1:27017/aljo_agent_setup npm run agent:setup`, twice, then list the indexes.

## Open questions

- **`AGENT_ENABLED` default:** `false` everywhere (recommended — the agent is switched on per environment once it's ready), or `true` in development?

## Results

_Filled in when the work is done._

## Decision log

| Date | Decision | Why |
|---|---|---|
