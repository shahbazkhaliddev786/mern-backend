# 017 — Tracing and the prompt-cache hit rate

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M6 — Hardening ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | `d4ffd11` |
| **Repo** | `mern-backend` only |

## Goal

Every agent request produces one trace: the HTTP request, the agent's steps, each model call, each tool, and the MongoDB queries under them. The trace is viewable in LangSmith, and it can also go to a general tracing backend. Each model call records its tokens and prompt-cache hit rate, so a silent cache break (a changed prompt or tool list) shows up at once.

## Context

- **Design:**
  - [`observability.md`](../shopping-agent/observability.md): OpenTelemetry is the backbone, one trace from HTTP down to MongoDB; LangSmith is the LLM-native view; the minimum trace schema; the "cache-read hit rate dropping" alert.
  - [`tech-stack.md`](../shopping-agent/tech-stack.md) Layer 9: `@opentelemetry/sdk-node`, OpenLLMetry (`@traceloop/node-server-sdk`), `langsmith`.
  - [`phases.md`](../shopping-agent/phases.md) M6 exit criterion: "one trace shows the full path of a checkout turn".
- **What exists:**
  - **Installed but unused:**
    - OpenTelemetry: `@opentelemetry/sdk-node`, `@opentelemetry/api`, `@opentelemetry/auto-instrumentations-node` (which includes the HTTP, Express, MongoDB and Mongoose instrumentations), `@opentelemetry/exporter-trace-otlp-proto`
    - OpenLLMetry
    - `langsmith` 0.10.8, which can emit its traces as OpenTelemetry spans (`LANGSMITH_OTEL_ENABLED`)
  - `LANGSMITH_TRACING`, `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT` in `AgentConfig` (spec 003).
  - Audit log lines carrying ids for writes, confirmations, escalations, retrieval and alerts (specs 008–016).
- **Constraints:**
  - **The backend is an ES module** (`"type": "module"`). OpenTelemetry's auto-instrumentation patches CommonJS `require`, so ESM code needs its loader hook (`import-in-the-middle`, installed) registered before the app's modules load.
  - **Production runs as a Vercel serverless function** (`api/index.ts`). A function can be frozen once its response ends, so buffered spans must be flushed before the agent response finishes.
  - **No customer data may leave in a form the store doesn't control.** Card data is already blocked (spec 016).

## Scope

**In:**
- **Tracing setup:** `src/tracing.ts`, loaded first by both entry points.
- **Auto-instrumentation:** HTTP, Express, MongoDB and Mongoose.
- **Agent spans:** LangSmith's OpenTelemetry mode for the agent and model calls (open question 1).
- **An `agent.turn` span** carrying the trace schema's ids and outcome.
- **Token usage and the cache hit rate**, per model call.
- **Exporters:** LangSmith, plus an optional general OTLP backend.
- **Flush:** at the end of each agent request.
- **Trace ids in log lines,** so a log alert leads to its trace.

**Out:**
- Dashboards, and alert rules in any backend (they need the backend chosen and running).
- Online evals and sampled LLM judging (Layer 6; M7).
- Tracing the non-agent store routes beyond what the HTTP and Express instrumentation gives for free.

## Design

> **As built:** task 1 changed the source of the agent spans. LangSmith's OpenTelemetry mode doesn't cover LangGraph, so the `agent.turn`, model-call and per-tool spans are created in our own code (`chat.service.ts`, `graph.ts`). Everything else below holds. See the decision log.

**Proving the setup first (task 1).** Two things are uncertain enough to check before building on them, in a small local run with an in-memory exporter:
1. Does the ESM loader hook give HTTP, Express and MongoDB spans in this app, run by `tsx` locally and by Node from `dist/` on Vercel?
2. Do LangSmith's OpenTelemetry spans nest under the HTTP span, in one trace?

If either fails, the fallback is recorded in the decision log before going further: manual spans around the agent route, or OpenLLMetry's LangChain instrumentation.

**Setup** — `src/tracing.ts`, imported first in `src/index.ts` and `api/index.ts` (and registered with `--import` where a loader hook is required):
- **Off unless `LANGSMITH_TRACING=true`** or an OTLP endpoint is set; then nothing loads, and the store and its tests run as today.
- **Provider:** a `NodeSDK` with:
  - **Resource:** `service.name=aljo-store-backend`, plus the deployment environment.
  - **Instrumentations:** HTTP, Express, MongoDB and Mongoose. Database statements are off, so no query values or document contents are recorded.
  - **Span processors:**
    - LangSmith's OTLP exporter, from `LANGSMITH_API_KEY` and `LANGSMITH_PROJECT`.
    - If `OTEL_EXPORTER_OTLP_ENDPOINT` is set (with the standard `OTEL_EXPORTER_OTLP_HEADERS`), a second OTLP exporter for the general backend. That exporter drops message content (open question 3).
- **LangSmith's OpenTelemetry mode** (`LANGSMITH_OTEL_ENABLED=true`): LangChain's run tree (graph nodes, model calls, tools) comes out as spans inside the active trace, instead of as a separate LangSmith-only trace.
- **Sampling:** every agent request is traced (traffic is small). Other routes follow the default sampler.

**The `agent.turn` span** (the chat service, around each turn). Its attributes, from observability.md's minimum trace schema:
- `agent.thread` (the thread id), `agent.user` (a hashed user id, never the raw id or email)
- `agent.prompt_version`, `agent.kind` (`message` or `resume`)
- `agent.tool_calls`, `agent.escalated`, `agent.escalation_reason`
- `agent.outcome`: `answered`, `confirm_required`, `gave_up`, `refused`, `error` or `aborted`

Rate-limit refusals (spec 014) and sensitive-input refusals (spec 016) are events on the HTTP span; no turn runs for them.

**Token usage and the cache hit rate** (agent node, after each model call):
- **Read** from `usage_metadata`: input, output, `cache_read` and `cache_creation` tokens.
- **Recorded** on the model span and in `AGENT_MODEL_USAGE { thread, model, effort, input, output, cacheRead, cacheCreation, cacheHitRate }`, ids and numbers only.
- **`cacheHitRate`** = `cacheRead / (input + cacheRead + cacheCreation)`.
- **The log line** feeds the "cache-read hit rate dropping" alert once a backend is chosen, and the per-turn cost estimate the spec 014 budget numbers were based on.

**Flush.**
- At the end of each agent request (chat and avatar upload), the handler awaits `forceFlush()` with a 2-second cap before ending the response, so a Vercel freeze doesn't lose spans.
- A flush failure is logged and never fails the request.

**Logs:** a winston format adds `traceId` and `spanId` from the active span to every log line written inside a trace, so `AGENT_ALERT` and the other audit lines link to their trace.

## Tasks

- [x] Task 1: the setup check above (ESM hook, nesting); record the outcome
- [x] `src/tracing.ts`; imported first by both entry points; env vars in `config.ts` and `.env.example`
- [x] `agent.turn` span and its attributes in the chat service
- [x] Token usage and cache hit rate in the agent node; `AGENT_MODEL_USAGE`
- [x] Flush at the end of agent requests
- [x] Trace ids in log lines
- [x] Tests (below)
- [x] Update `observability.md` (what's built), `tech-stack.md` (the OpenLLMetry decision), `phases.md` §0 and the spec index

## Acceptance criteria

- [x] **Off by default:** with tracing off, nothing is registered or exported, and the existing suites are unchanged — test. (The OpenTelemetry modules are imported statically, so the instrumentations patch before the app loads; see the decision log)
- [x] **One trace for a checkout turn:**
  - [x] One HTTP chat request yields a single trace (in-memory exporter) containing: the HTTP server span → `agent.turn` → agent model call(s) → `place_order` tool → MongoDB spans under the tool.
  - [x] Every span has the same trace id.
  - [x] Covered by an HTTP test (`MONGO_URL`, with the model scripted and Stripe mocked). This is the M6 exit criterion.
- [x] **Turn attributes:**
  - [x] Thread, hashed user, prompt version, tool-call count, escalation and outcome are set for an answered turn, a confirmation pause, and an escalated turn.
  - [x] No raw user id or email appears in any span attribute.
  - [x] Covered by tests.
- [x] **Cache usage:**
  - [x] A response reporting `cache_read` tokens yields the right `cacheHitRate` on the span and in `AGENT_MODEL_USAGE`.
  - [x] A response without usage reports nothing, and nothing fails.
  - [x] Covered by tests.
- [x] **No database values:** MongoDB spans carry no document contents or query values; the query's shape is kept with every value masked as `?` — test
- [x] **Flush:**
  - [x] The chat handler flushes before ending the stream.
  - [x] A hanging exporter delays the response by at most 2 seconds.
  - [x] Covered by a test.
- [x] **Log correlation:** a log line written inside a request carries that request's `traceId` — test
- [x] **Checks:** backend lint 0 errors, build, `npm test` 221 + 32 skipped / 253 with `MONGO_URL` and `ATLAS_URL` (run four times, stable)

## Test plan

- **Unit and HTTP tests:** an `InMemorySpanExporter` registered in place of the real exporters (a test hook in `tracing.ts`).
- **Not in this spec:** a real export to LangSmith or a general backend. That needs `LANGSMITH_API_KEY` (and an OTLP endpoint) and is parked with the other live checks, along with checking the trace in LangSmith's UI.

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**2026-10-10** — backend only.
- **Files:**
  - `src/tracing.ts` (start, exporters, flush, stop), imported first by `src/index.ts` and `api/index.ts`
  - `agent.turn` span in `chat.service.ts`
  - model-call and per-tool spans, and `AGENT_MODEL_USAGE`, in `graph.ts`
  - the route name, refusal events and flush in `agent.controller.ts`
  - trace ids in `logger.ts`
  - `OTEL_EXPORTER_OTLP_*` in `config.ts` and `.env.example`
  - `@traceloop/node-server-sdk` removed (160 packages out of the lockfile, nothing added or upgraded)
  - `@opentelemetry/instrumentation-http` and `-mongodb` declared (already installed, same versions)
- **The checkout turn's trace** (`tracing.mongo.test.ts`, real router, tools and MongoDB):

```
POST /agent/chat
└─ agent.turn            agent.kind=resume  agent.outcome=answered  agent.tool_calls=1
   ├─ tool place_order   gen_ai.tool.name=place_order  agent.confirm_required=true  agent.tool_ok=true
   │  └─ find carts, find products, find pendingcheckouts, insert pendingcheckouts…   (values masked)
   └─ chat claude-sonnet-5-5   gen_ai.usage.*  agent.cache_hit_rate
```

  No user id, email, address or query value appears in any span.
- **New tests (13):**
  - `tracing.test.ts` (2): off by default; a flush gives up on a hanging exporter
  - `tracing.mongo.test.ts` (2): the checkout trace above; the pause outcome
  - `turn-span.test.ts` (8): outcomes for answered, confirmation, escalation and support-offer turns; usage and the cache rate; trace ids on log lines
  - The existing suites are unchanged.
- **Checked under plain Node from `dist/`** (what Vercel runs): the MongoDB instrumentation patches the driver, and a query inside a span is traced with values masked.
- **Not yet seen:** a real export to LangSmith (needs `LANGSMITH_API_KEY`), and how the trace looks in its UI. Parked with the other live checks.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved with the defaults: LangSmith's OpenTelemetry mode for agent and model spans (OpenLLMetry removed as unused); a general backend through the standard `OTEL_EXPORTER_OTLP_*` variables, none chosen now; full prompts and replies in LangSmith only, no message content in the general backend, hashed user ids everywhere | Owner's choice |
| 2026-10-10 | **Task 1 result: our own spans instead of LangSmith's OpenTelemetry mode** (owner's choice between the two tested options). LangSmith's mode only decorates spans its own `traceable()` wrapper starts, so LangChain's callback runs (the whole LangGraph agent) produced no spans at all. OpenLLMetry's LangChain instrumentation put everything in one trace but flat: every span directly under the HTTP request, tools named "DynamicStructuredTool", MongoDB queries not under their tool. Spans started in our graph code nest correctly through LangGraph (`agent.turn` → `tool view_cart` → `find carts`, checked under `tsx` with a real MongoDB) | Our spans carry the tool's real name, the model, tokens and cache rate, and never message text. LangSmith keeps its normal LangChain tracing (prompts and the agent's steps), linked to the trace by its id. OpenLLMetry is removed as unused |
| 2026-10-10 | `cacheHitRate` = `cacheRead / input_tokens` | `@langchain/anthropic` already adds the cache-read and cache-creation tokens into `input_tokens` |
| 2026-10-10 | Express spans aren't used; the agent routes name the HTTP span themselves (`POST /api/v1/agent/chat`) | The Express instrumentation didn't patch Express 5 when imported from ESM; the HTTP and MongoDB instrumentations did |
| 2026-10-10 | With tracing off, the OpenTelemetry modules still load; nothing is registered or exported | The instrumentations must patch `http` and the MongoDB driver before anything imports them, and under ESM only a static import first in the entry point guarantees that |
| 2026-10-10 | MongoDB spans keep the query's shape (`{"find":"?","filter":{"user":"?"}}`) with every value masked | The instrumentation's default; useful for slow-query debugging, and no value leaves. A test checks every value is `?` |
| 2026-10-10 | Only queries made inside a request are traced | The MongoDB instrumentation needs a parent span; background queries (connection housekeeping, the log transport) don't clutter traces |
| 2026-10-10 | Each tool call runs as its own `ToolNode` call (still in parallel) inside its own span | So each tool's queries nest under that tool |
| 2026-10-10 | No content-stripping exporter for the general backend | Our spans never carry message text, so there's nothing to strip |
| 2026-10-10 | The agent handler flushes before ending its response; the HTTP request span itself ends just after, so on Vercel it may wait in the buffer until the next flush (or be lost if the function is frozen first) | The turn, model, tool and query spans are always sent. Follow-up if needed: flush after the response with Vercel's `waitUntil` (`@vercel/functions`, not installed) |
| 2026-10-10 | `startTracing` clears any earlier OpenTelemetry registration before registering, and `stopTracing` (tests) gives up on a hanging exporter after a second | The registrations are process-wide and can't be replaced once set; in tests, a previous file's could linger. At start-up there's nothing to clear |
| 2026-10-10 | Tests flush before reading spans | Spans are exported asynchronously even by the immediate processor; under load the reads ran ahead of the exports |
