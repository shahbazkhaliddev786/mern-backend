# AI Shopping Assistant — Tech Stack & Layers

> Full stack organized by architectural layer. Each row: **technology → package/model → role → one-line why.** Companion to [`architecture.md`](./architecture.md) (diagram), [`observability.md`](./observability.md), [`evals.md`](./evals.md), and [`security.md`](./security.md).

**At a glance:** MERN · LangGraph.js · Claude Sonnet 5.5 + Haiku 5.5 (+ Opus 5.5 escalation) · MongoDB product search (Typesense only if evals need it) · RAG (Voyage embeddings + MongoDB Atlas hybrid + Voyage rerank) · Zod tool schemas · short-term memory (Mongo checkpointer) · OpenTelemetry → LangSmith · DeepEval-TS. One backend language (Node/TS), one datastore (MongoDB).

---

## Layer 1 — Client / Presentation

| Tech | Package | Role | Why |
|---|---|---|---|
| React | `react` (Vite) | Chat UI | Standard SPA; part of MERN |
| SSE | `fetch()` + `ReadableStream` (POST, Bearer header) / Express SSE | Stream tokens + tool events | Real-time "Searching… → results → Confirm?" UX without WebSocket overhead. Not native `EventSource`: it can't POST or send the `Authorization` header ([`reconciliation.md`](./reconciliation.md) Gap 14) |

---

## Layer 2 — API / Backend

| Tech | Package | Role | Why |
|---|---|---|---|
| Node.js | — | Runtime | One language across app + agent |
| Express | `express` | HTTP API, routing, middleware | MERN standard; hosts the agent in-process |

---

## Layer 3 — Agent / Orchestration

| Tech | Package / Model | Role | Why |
|---|---|---|---|
| LangGraph.js | `@langchain/langgraph`, `@langchain/core` | Agent graph (nodes, edges, state) | Single agent + tools; native `interrupt()` HITL; checkpointer |
| Claude binding | `@langchain/anthropic`, `@anthropic-ai/sdk` | LLM calls | Official SDK |
| **Agent model** | **Claude Sonnet 5.5** (`claude-sonnet-5-5`) | Reasoning + tool selection (routes via native tool use) | Best tool-use/cost balance; 1M ctx; adaptive thinking |
| **Knowledge context model** | **Claude Haiku 5.5** (`claude-haiku-5-5`) | The one-line context per knowledge chunk, at ingestion | Cheap and offline. No query rewrite at request time (spec 013), and no separate intent router until evals justify one ([`reconciliation.md`](./reconciliation.md) Gap 3) |
| **Escalation model** | **Claude Opus 5.5** (`claude-opus-5-5`) | Retry stuck turns (loop, step budget, repeated tool error) | Higher success on the hard tail; invoked rarely so cost stays bounded |
| HITL gate | LangGraph `interrupt()` | Confirm before irreversible / bulk / account / external writes | Those actions need explicit user yes; reversible cart edits skip it |

**Model API rules these choices bring** (checked 2026-10-10 against the Claude API reference; re-check when models change):
- **Thinking is controlled by effort, not a token budget.** All three models use adaptive thinking; set `output_config.effort` explicitly and tune it with evals (start around `low`–`medium` for chat turns). `thinking: { type: 'enabled', budget_tokens }` is rejected with a 400, and Sonnet 5.5 also rejects `{ type: 'disabled' }`. Size `max_tokens` for thinking plus the reply.
- **No forced tool calls.** `tool_choice` `any` / `tool` returns a 400 on Sonnet 5.5 and Opus 5.5. Use `tool_choice: auto` with `strict: true` tool schemas, steer in the prompt, and check in code that a required call happened. Nothing safety-critical relies on forcing anyway: confirmation is enforced by `interrupt()` on the server.
- **History is append-only.** Thinking blocks are bound to the conversation that produced them: editing, trimming or reordering earlier turns, or rebuilding the system prompt or tool list between requests, invalidates them (a 400 for newly created accounts). So the system prompt and tool definitions are static, per-request facts arrive as messages or tool results, thinking blocks are passed back unchanged, and long conversations use server-side compaction instead of trimming. LangGraph's message state is append-only by default; don't add a `trimMessages` step.
- **Model switches drop reasoning.** On escalation, Opus 5.5 can't read Sonnet 5.5's thinking blocks; the API drops them unbilled and Opus re-plans from the visible history (more cost and latency on that turn). Pass the blocks back unchanged rather than stripping them.
- **Refusals are a stop reason.** Safety classifiers can end a turn with `stop_reason: 'refusal'` (category in `stop_details`). Check it before reading `content`, reply with a safe message plus the support option, and log the category. Server-side fallback retries only some categories on Sonnet 5.5, and Haiku 5.5 has none, so a refused chunk-context line at ingestion is simply left out.
- **Binding check (M1 spike) — done offline 2026-10-10, live run pending ([spec 001](../spec/001-m1-langchain-binding-check.md)):** the agent node uses `ChatAnthropic` from `@langchain/anthropic` 1.5.12. It sends `thinking` and `outputConfig.effort` as first-class options, `strict` tools through `bindTools(..., { strict: true })`, keeps mid-conversation `SystemMessage`s in place, round-trips thinking blocks unchanged, and exposes `stop_reason` / `stop_details` in `response_metadata`. Refusal `fallbacks` have no first-class option and go through `invocationKwargs`. Don't use default-method `withStructuredOutput`; use `outputConfig.format` for JSON output.

---

## Layer 4 — Tooling / Action

| Tech | Package | Role | Why |
|---|---|---|---|
| Tool schemas | `zod` (+ `zodToJsonSchema`) | Typed, validated tool I/O | Type-safe tool args; schema = contract |
| Read tools | — | `search_products`, `get_product_details`, `ask_store_knowledge`, `view_cart`, `view_orders`, `get_order_status`, `view_profile` | Auto-execute (low blast radius) |
| Write tools — auto | — | `add_to_cart`, `update_cart_item` | Reversible, no money moves → auto-execute, audit-logged |
| Write tools — confirm | — | `clear_cart`, `place_order` (reuses an open checkout), `cancel_order`, `update_profile` (name only), `upload_avatar`, `submit_support_request` | Gated behind `interrupt()` confirmation |
| Payment | Stripe Checkout (hosted) + signed webhook | `place_order` wraps `createCheckoutSession`: a `PendingCheckout` (24h TTL) + Stripe session, returning the checkout link. The webhook creates the paid `Order` (`status: 'pending'`, `paymentStatus: 'paid'`). `cancel_order` on a paid order triggers a server-side Stripe refund. Stripe-only in v1 | Agent never touches card data or payment state; one payment path for UI and agent |
| Address validation | `zod` (shared with `/checkout` form) | Validates `place_order`'s `shippingAddress` | One schema for UI and agent — no drift between the two paths |
| Uploads | `POST /uploads/avatar` + a TTL'd `PendingUpload` (built with the chat UI) | Chat UI uploads the image → server applies the avatar limits (≤ 2 MB JPEG/PNG/GIF/WEBP) and stores it → opaque `uploadId` passed to `upload_avatar` | Agent never handles file bytes |

Full catalog with schemas/notes: [`architecture.md`](./architecture.md) §4.

---

## Layer 5 — Retrieval / RAG

| Tech | Package / Model | Role | Why |
|---|---|---|---|
| **Product search** | MongoDB query (existing `getAllProductsService`) in v1; Typesense (`typesense`) only if evals need it | Faceted catalog search | Search problem, not RAG — exact filters (price, stock); the catalog is small enough for Mongo |
| Search question | The agent model (Sonnet 5.5), in the tool call | A self-contained question for `ask_store_knowledge` | Conversational turns aren't searchable raw; the agent already sees the conversation, so a separate rewrite hop was dropped (spec 013) |
| Embeddings | **Voyage `voyage-3.5`** (`voyageai`) | Vectorize store-knowledge chunks | Claude-native recommended embeddings |
| Vector + lexical | MongoDB Atlas Vector Search + Atlas Search (BM25) | Hybrid retrieve (top ~20) | Keyword + semantic; one datastore |
| Rerank | **Voyage `rerank-2.5`** | Precision rerank (top ~4) | Cheap precision bump; wrong answer = false promise |
| Chunking | Structural + Anthropic Contextual Retrieval | Ingestion: 1 logical unit/chunk + context prefix | Docs pre-structured; fixed-size splits mid-policy |

---

## Layer 6 — Data / Persistence

| Tech | Package | Role | Why |
|---|---|---|---|
| MongoDB Atlas | `mongodb` / `mongoose` | `products`, `orders`, `pendingcheckouts`, `users`, `carts` | MERN DB; authoritative records |
| Atlas Vector Search | `$vectorSearch` | Store-knowledge vector index | Reuse DB — no separate Pinecone/Qdrant |
| Atlas Search | `$search` (Lucene BM25) | Lexical half of hybrid | Keeps hybrid retrieval in one DB |

---

## Layer 7 — Memory

| Tech | Package | Role | Status | Why |
|---|---|---|---|---|
| **Short-term** | `@langchain/langgraph-checkpoint-mongodb` | Thread state (conversation) | ✅ now | Reference resolution: "add the blue one", "yes confirm" |
| Long-term (structured) | Mongo collections + tools | Orders/profile/cart | ✅ via tools | Authoritative data — never paraphrased from LLM memory |
| Long-term (inferred) | LangGraph `BaseStore` (Mongo), keyed by `user_id` | Learned preferences | 🟡 phase 2 | Personalization; bounded, with privacy controls |

---

## Layer 8 — Security / Auth (cross-cutting)

| Tech | Package | Role | Why |
|---|---|---|---|
| Session / JWT | existing MERN auth | Authenticate user | Identity lives server-side |
| Token injection | custom middleware | Inject `user_id` + scoped token into tool calls server-side | LLM never handles creds |
| Per-tool authz | DB-level `WHERE user_id = ?` | Enforce access in every tool | Assume LLM can be jailbroken; authz in DB, not prompt |
| Injection/PII guards | custom | Delimit tool-result text; block card/cred patterns | Reviews/product text are attacker-controllable |

---

## Layer 9 — Observability (cross-cutting)

| Tech | Package | Role | Why |
|---|---|---|---|
| **OpenTelemetry** | `@opentelemetry/sdk-node`, `@opentelemetry/api` | Tracing backbone; `gen_ai.*` spans | Correlate LLM + Mongo + HTTP in one trace; no vendor lock-in |
| OpenLLMetry | `@traceloop/node-server-sdk` | OTel auto-instrumentation for LLM/vector/framework | Emit OTel LLM spans without hand-instrumenting; **extends OTel, not a competitor** |
| LangSmith | `langsmith` | LLM-native trajectory view + online evals | Richest agent trace UX; ingests OTLP |
| General backend | Grafana/Tempo · Datadog (OTLP) | Full-stack metrics/traces | Vendor-neutral target |

---

## Layer 10 — Evaluation / Quality

| Tech | Package | Role | Why |
|---|---|---|---|
| **DeepEval-TS** | `deepeval` (TS, Vitest) | Offline metric suite as CI gate | Named metrics (faithfulness, contextual precision/recall, tool-correctness); stays in Node. Beta — fallback LangSmith evals |
| Vitest | `vitest` | Test runner for eval suite | TS-native pytest equivalent |
| Online evals | LangSmith sampled LLM-judge | Production drift detection | Catch regressions live; failing traces → golden set |
| CI | GitHub Actions | Run eval gate on PR | Ship/no-ship gate before deploy |

---

## One-language / one-datastore summary

- **Language:** everything backend is **Node/TS** — agent, tools, evals (DeepEval-TS), OTel. No Python service.
- **Datastore:** everything is **MongoDB Atlas** — app data, vector index, lexical index, short-term memory checkpoints, (phase-2) preference store. No separate vector DB.
- **Models:** **Claude** for reasoning (Sonnet 5.5 + Haiku 5.5, Opus 5.5 for escalation and offline eval judging), **Voyage** for embeddings + rerank.

> **Interview line:** "I kept it to one backend language and one datastore deliberately — fewer moving parts, one trace to debug, one place for authz. Complexity is a cost I only pay when the use case demands it."
