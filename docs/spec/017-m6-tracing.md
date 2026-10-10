# 017 — Tracing and the prompt-cache hit rate

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M6 — Hardening ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |
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

- [ ] Task 1: the setup check above (ESM hook, nesting); record the outcome
- [ ] `src/tracing.ts`; imported first by both entry points; env vars in `config.ts` and `.env.example`
- [ ] `agent.turn` span and its attributes in the chat service
- [ ] Token usage and cache hit rate in the agent node; `AGENT_MODEL_USAGE`
- [ ] Flush at the end of agent requests
- [ ] Trace ids in log lines
- [ ] Tests (below)
- [ ] Update `observability.md` (what's built), `tech-stack.md` (the OpenLLMetry decision), `phases.md` §0 and the spec index

## Acceptance criteria

- [ ] **Off by default:** with tracing off, no OpenTelemetry code loads, and the existing suites are unchanged — test
- [ ] **One trace for a checkout turn:**
  - [ ] One HTTP chat request yields a single trace (in-memory exporter) containing: the HTTP server span → `agent.turn` → agent model call(s) → `place_order` tool → MongoDB spans under the tool.
  - [ ] Every span has the same trace id.
  - [ ] Covered by an HTTP test (`MONGO_URL`, with the model scripted and Stripe mocked). This is the M6 exit criterion.
- [ ] **Turn attributes:**
  - [ ] Thread, hashed user, prompt version, tool-call count, escalation and outcome are set for an answered turn, a confirmation pause, and an escalated turn.
  - [ ] No raw user id or email appears in any span attribute.
  - [ ] Covered by tests.
- [ ] **Cache usage:**
  - [ ] A response reporting `cache_read` tokens yields the right `cacheHitRate` on the span and in `AGENT_MODEL_USAGE`.
  - [ ] A response without usage reports nothing, and nothing fails.
  - [ ] Covered by tests.
- [ ] **No database values:** MongoDB spans carry no document contents or query values — test
- [ ] **Flush:**
  - [ ] The chat handler flushes before ending the stream.
  - [ ] A hanging exporter delays the response by at most 2 seconds.
  - [ ] Covered by a test.
- [ ] **Log correlation:** a log line written inside a request carries that request's `traceId` — test
- [ ] **Checks:** backend lint 0 errors, build, `npm test` with and without `MONGO_URL` / `ATLAS_URL`

## Test plan

- **Unit and HTTP tests:** an `InMemorySpanExporter` registered in place of the real exporters (a test hook in `tracing.ts`).
- **Not in this spec:** a real export to LangSmith or a general backend. That needs `LANGSMITH_API_KEY` (and an OTLP endpoint) and is parked with the other live checks, along with checking the trace in LangSmith's UI.

## Open questions

1. **How agent and model spans are produced.** The docs planned OpenLLMetry (Traceloop) for LLM spans.
   - **Recommended:** LangSmith's own OpenTelemetry mode instead. LangChain already reports every graph node, model call and tool run (with token usage) to LangSmith. In OpenTelemetry mode those runs become spans in the same trace as HTTP and MongoDB.
   - **Why not both:** adding OpenLLMetry too would record each model call twice.
   - **Consequence:** `@traceloop/node-server-sdk` would then be removed as unused, and tech-stack.md updated.
   - **If task 1 shows LangSmith's mode doesn't nest correctly,** OpenLLMetry becomes the fallback.
2. **The general tracing backend.**
   - **Recommended:** support it through the standard `OTEL_EXPORTER_OTLP_*` variables but don't choose one now. LangSmith alone is enough until there's traffic. Grafana Cloud or Honeycomb can be plugged in later without code changes.
3. **Message content in traces.**
   - **Recommended:**
     - **LangSmith:** full prompts and replies, which are needed to replay a turn and build eval datasets. LangSmith is access-controlled and has its own retention.
     - **General backend:** spans without message content.
     - **Everywhere:** user ids hashed. Card data never reaches either, since spec 016 blocks it before the model.

## Decision log

| Date | Decision | Why |
|---|---|---|
