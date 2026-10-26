# 013 — Store knowledge (`ask_store_knowledge`)

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M5 — Store knowledge (RAG) ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | `bed57d4` |
| **Repo** | `mern-backend` only (answers show in the existing chat panel) |

## Goal

The agent answers questions about shipping, returns, payments, orders, accounts, support and the store itself from `mern-backend/knowledge/`, and only from it. Each answer is grounded in the passages it retrieved. When the knowledge doesn't cover a question, the agent says so and offers the contact options, instead of guessing.

## Context

- **Design:**
  - [`phases.md`](../shopping-agent/phases.md) M5.
  - [`architecture.md`](../shopping-agent/architecture.md) §1 (the RAG query pipeline), §2 (ingestion) and §4 (`ask_store_knowledge`: read, no confirmation).
  - [`tech-stack.md`](../shopping-agent/tech-stack.md) Layer 5: Voyage `voyage-3.5` embeddings, Atlas Vector Search + Atlas Search (BM25) hybrid, Voyage `rerank-2.5`.
  - [`evals.md`](../shopping-agent/evals.md): contextual recall ≥ 0.8, precision ≥ 0.7, faithfulness ≥ 0.9.
- **The corpus:**
  - 7 files and 37 `##` questions. 10 of them are `TODO(owner)` and are never indexed, which leaves **27 live chunks** (about 1,900 words in all).
  - The owner's open items are listed in [`knowledge/README.md`](../../knowledge/README.md).
- **Already in place:**
  - the `voyageai` 0.4.0 client
  - `VOYAGE_API_KEY` in `AgentConfig` (spec 003)
  - `AGENT_MODELS.queryRewrite` = Haiku 5.5
  - `npm run agent:setup` (spec 003), which this spec extends with the two search indexes
  - the read-tool pattern from spec 005
- **What's missing:** the ingestion script, the knowledge collection and its indexes, the retrieval service, the tool, and the goldens.
- **Testing locally:** `$vectorSearch` and `$search` don't exist in plain MongoDB. They do in the `mongodb/mongodb-atlas-local` Docker image, which can be pulled here. So the tests can run real hybrid queries without an Atlas account.
- **Numbering:** 013 was pencilled in for `cancel_order`, which was deferred without a spec file (`phases.md` M4 step 5). This spec takes the number.

## Scope

**In:**
- **Ingestion:** `npm run agent:ingest`, which chunks, adds context, embeds and upserts.
- **Indexes:** the knowledge collection and its two search indexes, created by `agent:setup`.
- **Retrieval:** hybrid search, fusion, rerank and a relevance cut-off.
- **The tool:** `ask_store_knowledge` (auto, read-only).
- **Prompt:** the knowledge rules, and `PROMPT_VERSION` 6.
- **Design docs:** drop the Haiku query rewrite from architecture.md §1, tech-stack.md Layers 3 and 5, and reconciliation Gap 3.
- **Goldens:** a golden file for the knowledge evals, plus the DeepEval test that runs it.

**Out:**
- **Running the LLM-judge evals** and tuning against their scores. Parked with the other live checks: it needs `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`.
- **Answering the `TODO(owner)` items.** Those are the store owner's (see `knowledge/README.md`).
- **Product search,** which isn't RAG (architecture.md §5).
- **Citation links in the chat panel.** The answer names its topic in words.

## Design

**Ingestion** — `src/agent/rag/ingest.ts`, run with `npm run agent:ingest`. It reads `knowledge/*.md`, except `README.md`:

1. **Chunk.**
   - Each `##` heading and the text under it is one chunk; the file's `#` title is kept with it.
   - HTML comments (the source notes) are stripped.
   - Any chunk containing `TODO(owner)` is skipped.
   - Chunk id: `<file>#<slug of the question>`, e.g. `returns.md#how-long-do-i-have-to-return-something`.
2. **Context line** (contextual retrieval).
   - Haiku 5.5 writes one sentence placing the chunk within its file, e.g. *"From Aljo Store's returns policy: the return window."*
   - On a refusal or an error, the chunk gets no context line; ingestion doesn't fail.
3. **Embed.**
   - The embedded text is `title + context + question + text`.
   - Model `voyage-3.5`, `inputType: 'document'`, 1024 dimensions.
4. **Upsert** into `knowledge_chunks`:
   - fields: `{ _id, file, title, question, text, context, embedding, contentHash, updatedAt }`
   - **Unchanged chunks are skipped:** a chunk whose `contentHash` (sha256 of title + question + text) hasn't changed keeps its embedding and context, so re-running costs nothing.
   - **Stale chunks are deleted:** a chunk that has left the files is removed, including one that gained a `TODO(owner)`.
5. **Report and dry run.**
   - It prints counts: added, updated, unchanged, removed, skipped (TODO).
   - `--dry-run` prints the chunks without calling Claude or Voyage, so it works without keys.

**Indexes** — added to `npm run agent:setup`, still idempotent:
- `knowledge_vector`: an Atlas Vector Search index on `embedding` (1024, cosine).
- `knowledge_text`: an Atlas Search index on `question`, `text`, `title` and `context` (`lucene.english` analyzer).
- Two search indexes fit Atlas's free tier (M0 allows three).

**Retrieval** — `searchKnowledge(question)` in `src/agent/rag/retrieve.ts`:
1. **Two searches in parallel:**
   - `$vectorSearch` with the question embedded as `inputType: 'query'` (`numCandidates` 100, limit 20)
   - `$search` over `question` (boosted ×2), `text`, `title` and `context` (limit 20)
2. **Fusion.** Reciprocal-rank fusion (k = 60) in code, keeping the top 20.
   - Fusing in code works on every Atlas tier; `$rankFusion` would need MongoDB 8.1.
3. **Rerank.** `rerank-2.5` keeps the top 4.
4. **Cut-off.** Chunks with a relevance score under **0.3** are dropped. That's a starting value, tuned with the goldens.
5. **Result.** `{ found, passages: [{ id, topic, question, text, score }] }`, where `topic` is the file title.
   - `found` is `false` when no passage clears the cut-off, or when the collection is empty.

The embedder, reranker and search calls are injected (`RetrievalDeps`), so unit tests run without Voyage.

**Tool** — `ask_store_knowledge({ question })`:
- **Kind:** read, auto, no identity fields, built per request like the other tools.
- **`question`:** 3–300 characters. The description asks for **a self-contained question** that resolves anything said earlier ("and for that?" → "What is the return window for shoes?"). There is no separate query-rewrite step (decision log).
- **Returns:**
  - `{ found: true, passages: [{ topic, question, text }] }`
  - or `{ found: false, contact: "…" }`. The contact text names the `/contact` page and hello@aljostore.com (`knowledge/contact-and-support.md`), and the offer of `submit_support_request`.
- **Errors:** a Voyage or search failure → `toolError("I can't look that up right now…")` with the same contact text, and the error is logged.
- **Audit log:** `AGENT_RETRIEVAL { userId, found, ids, topScore }`, with ids only and no question text.
- **Label:** `TOOL_LABELS.ask_store_knowledge` = "Checking store policies…".

**Prompt** (`PROMPT_VERSION` 6):
- For questions about shipping, returns, refunds, payments, orders, accounts, support, or the store itself, call `ask_store_knowledge` before answering.
- Answer only from the passages, and say which topic the answer comes from ("Per our returns policy, …").
- Never fill gaps from general knowledge.
- If `found` is false, or the passages don't answer the question, say the store hasn't published that, and give the contact options. Offer to send the question to support.
- Questions about the customer's own orders, cart or profile still go to the account tools. Knowledge covers policy, not their records.

**Goldens** — `evals/knowledge.goldens.json` and `evals/knowledge.eval.test.ts`:
- **One golden per live chunk (27):**
  - a customer-style question
  - an `expectedOutput` restating the chunk only (evals.md §15: never invent policy)
  - the `expectedChunkIds`
- **Five fallback goldens,** drawn from `TODO(owner)` topics (delivery time, tracking, return conditions, refund timing, phone number). Each expects `found: false` and the contact options.
- **The eval test:**
  - it runs DeepEval's contextual precision, recall, relevancy and faithfulness against the real pipeline
  - it is skipped unless both API keys are set
  - it isn't part of `npm test`; it runs with `npm run eval:knowledge`
- **A deterministic test that runs in `npm test`:** it uses Atlas local, the real `$search`, and a fake embedder that is a bag-of-words hash. For at least 80% of the goldens, an expected chunk is in the fused top 5. That's a lexical floor; with only 27 chunks, a top-20 check would pass by default. The real embedder and rerank are judged by the evals.

## Tasks

- [x] Chunker (pure function) + `ingest.ts` + `npm run agent:ingest` (`--dry-run`)
- [x] `agent:setup`: `knowledge_vector` and `knowledge_text` indexes
- [x] `retrieve.ts`: hybrid search, RRF, rerank, cut-off; injected deps
- [x] `ask_store_knowledge` tool, label, audit log; prompt + `PROMPT_VERSION` 6
- [x] Goldens + DeepEval test + `npm run eval:knowledge`
- [x] Tests (below)
- [x] Design docs: remove the query-rewrite step (architecture.md, tech-stack.md, reconciliation Gap 3, phases.md M5)
- [x] Update `phases.md` §0, `knowledge/README.md` (how to re-ingest), and the spec index

## Acceptance criteria

- [x] **Chunker:** 27 chunks from today's files, ids are stable, no chunk contains `TODO(owner)` or an HTML comment, and each carries its file title — unit test
- [x] **Ingestion:**
  - [x] A second run changes nothing and makes no Voyage or Claude calls.
  - [x] An edited chunk is re-embedded.
  - [x] A removed chunk, or one that gained a `TODO(owner)`, is deleted.
  - [x] A context-line refusal doesn't stop ingestion.
  - [x] Covered by tests with mocked Voyage and Claude against MongoDB.
- [x] **`agent:setup`:** creates both search indexes on Atlas local, and running it again changes nothing — MongoDB test (Atlas local)
- [x] **Retrieval:**
  - [x] RRF ordering is correct.
  - [x] Only the top 4 passages after rerank are kept.
  - [x] Passages below the cut-off are dropped; none left → `found: false`; an empty collection → `found: false`.
  - [x] Covered by unit tests with injected deps.
- [x] **Hybrid on real search:** for at least 80% of the goldens, an expected chunk is in the fused top 5 — Atlas local test with the fake embedder
- [x] **Tool:**
  - [x] The schema has only `question`.
  - [x] It's auto (no confirmation).
  - [x] `found: false` and errors both carry the contact text.
  - [x] The audit log has no question text.
  - [x] Covered by tool tests.
- [x] **Graph:** a scripted turn calls `ask_store_knowledge` and the answer streams — graph test
- [x] **Goldens:** 27 + 5 (+ 3 follow-ups), each `expectedOutput` traceable to its chunk; `npm run eval:knowledge` skips cleanly without keys
- [x] **Checks:** backend lint 0 errors, build, `npm test` 157 + 28 skipped / 185 with `MONGO_URL` and `ATLAS_URL`

## Test plan

- **Unit:** the chunker, RRF, the cut-off, and the tool with injected deps.
- **MongoDB (`MONGO_URL`):** ingestion idempotency, with Voyage and Claude mocked.
- **Atlas local (`ATLAS_URL`, new):** the search indexes and real `$search` / `$vectorSearch` queries. It uses a `mongodb/mongodb-atlas-local` container on another port and is skipped without `ATLAS_URL`.
- **LLM-judge evals:** `npm run eval:knowledge`, parked until the keys are set. Its results go in this spec when it runs.

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**2026-10-10** — backend only.
- **Files:**
  - `src/agent/rag/`: `chunk.ts`, `context.ts`, `voyage.ts`, `ingest.ts`, `indexes.ts`, `retrieve.ts`, `knowledge.ts`
  - `src/agent/ingest.ts` (the `agent:ingest` command)
  - `src/agent/tools/ask-store-knowledge.ts`
  - `evals/knowledge.goldens.json`, `evals/knowledge.eval.ts`, `evals/vitest.config.ts`
  - plus edits to `setup.ts`, `config.ts`, `prompt.ts`, `stream.ts` and `tools/index.ts`
- **`npm run agent:ingest -- --dry-run`:** 27 chunks; 10 skipped (`TODO(owner)`).
- **`npm run agent:setup` on Atlas local:** created `knowledge_vector` and `knowledge_text`; a second run created nothing. On plain MongoDB it reports *"search indexes not created — this database isn't Atlas"* and the rest of setup still runs.
- **New tests (27):**
  - `chunk.test.ts` (7), including a check that every live chunk has a golden
  - `retrieve.test.ts` (6)
  - `ingest.mongo.test.ts` (5)
  - `knowledge.atlas.test.ts` (4)
  - 5 tool tests and 1 graph test
  - The config test now requires the Voyage key.
- **Lexical floor on Atlas local:** 93% (28 of 30 answerable goldens have an expected chunk in the fused top 5). The two misses are pure paraphrases ("What are your products made from?" → *materials*; "How do I buy something?" → *place an order*), which is what the real embedder is for.
- **Not yet run:** `npm run eval:knowledge` (contextual recall, precision and relevancy, plus faithfulness, judged by Opus 5.5). It needs `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, and an Atlas database that has been set up and ingested. The cut-off (0.3) gets tuned on that run.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | No Haiku query rewrite; the tool takes a self-contained `question` written by the agent model | The agent model writes the search query with the whole conversation in view, so a rewrite step adds a model call and a failure path for little gain. Follow-up goldens check it; the rewrite comes back if recall suffers |
| 2026-10-10 | Production runs on MongoDB Atlas (owner confirmed) | `$vectorSearch` and `$search` are available, so the design stands as written |
| 2026-10-10 | The `agent:ingest` command is `src/agent/ingest.ts`, next to `setup.ts`; the logic is in `src/agent/rag/ingest.ts` | Same layout as `agent:setup`; the logic is tested without the command's connection handling |
| 2026-10-10 | `VOYAGE_API_KEY` is now required when the agent is enabled | `ask_store_knowledge` is one of the agent's tools; spec 003 deferred this check to M5 |
| 2026-10-10 | `agent:setup` leaves an existing search index alone; changing a definition means giving the index a new name | Atlas rebuilds an index on update, and the stored definition includes defaults, so comparing them isn't reliable |
| 2026-10-10 | `agent:setup` reports, instead of failing, on a database without search (plain MongoDB) | Local development on plain MongoDB still gets the checkpointer indexes |
| 2026-10-10 | `AGENT_MODELS.queryRewrite` is renamed to `knowledgeContext` | With no query rewrite, Haiku's only job is the chunk context lines at ingestion |
| 2026-10-10 | 3 follow-up goldens were added (35 in all), each with the `searchQuery` it should become | Checks the dropped rewrite: the agent must turn "And what about tax?" into a self-contained question |
| 2026-10-10 | The eval checks the metric means against the evals.md thresholds; fallback goldens are checked deterministically (`found: false` and the contact details in the answer) | Per-golden thresholds would fail the run on one borderline judgement; the per-golden scores are printed for review |
| 2026-10-10 | `postinstall` deletes deepeval's stale `dist/telemetry.js`, and `eval:knowledge` sets `DEEPEVAL_TELEMETRY_OPT_OUT=YES` | As decided in spec 001 (C13): without it the metrics can't load |
