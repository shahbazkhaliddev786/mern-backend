# 001 — LangChain binding check

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M1 — Spikes & foundations ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |

## Goal

Decide, with evidence, how the agent node talks to Claude: through `@langchain/anthropic`'s `ChatAnthropic`, or through `@anthropic-ai/sdk` inside a custom LangGraph node. The decision is recorded here and in [`tech-stack.md`](../shopping-agent/tech-stack.md) Layer 3.

## Context

[`tech-stack.md`](../shopping-agent/tech-stack.md) Layer 3 lists API rules the agent's models impose and ends with: *"Binding check (M1 spike): confirm that `@langchain/anthropic` passes `output_config.effort`, adaptive thinking and `strict` tools, and surfaces `refusal` / `stop_details`. If not, call `@anthropic-ai/sdk` from a custom LangGraph node."* This spec is that check. It is the first item of M1 because every M2 file (graph, tools, stream) depends on the answer.

**What the lockfile shows today** (`package-lock.json`):

| Package | Installed | Note |
|---|---|---|
| `@langchain/anthropic` | 1.5.12 | Bundles its **own** `@anthropic-ai/sdk` **0.122.0** (nested), not the top-level 0.131.0. Its types and request building come from 0.122 |
| `@anthropic-ai/sdk` | 0.131.0 | Top level; what a custom node would use |
| `@langchain/core` | 1.2.17 | One copy |
| `@langchain/langgraph` | 1.4.20 | Peer `@langchain/core ^1.1.48` — satisfied |
| `deepeval` | 0.9.22 | Peer `@langchain/core` **exactly 1.1.31** — not satisfied; installed with `--legacy-peer-deps` ([`follow-ups.md`](../shopping-agent/follow-ups.md) §16) |

**API rules to verify** (Claude API reference, checked 2026-10-10):

| # | Rule | Applies to |
|---|---|---|
| R1 | Adaptive thinking is `thinking: { type: 'adaptive' }` (or omitted). `{ type: 'enabled', budget_tokens }` → 400. On Sonnet 5.5, `{ type: 'disabled' }` → 400 (the off switch is `{ type: 'between_tools' }`) | all three |
| R2 | Effort is `output_config: { effort: 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' }`. Defaults differ (Sonnet 5.5 `high`; Opus 5.5 and Haiku 5.5 `medium`), so it is always sent explicitly | all three |
| R3 | `strict: true` is a top-level field on each tool definition; the schema needs `additionalProperties: false` and `required` | all three |
| R4 | `tool_choice` `any` / `tool` → 400; use `auto` | Sonnet 5.5, Opus 5.5 |
| R5 | `stop_reason: 'refusal'` arrives as HTTP 200 with `stop_details: { type, category, explanation }`; `stop_details` is null otherwise | all three |
| R6 | Thinking blocks (with their signature) must be passed back unchanged on later turns; editing or dropping earlier turns invalidates them (400 for accounts created on or after 2026-08-31) | Sonnet 5.5, Opus 5.5 |
| R7 | A thinking block from Sonnet 5.5 sent to Opus 5.5 is dropped silently, unbilled — the request still succeeds | escalation |
| R8 | Thinking `display` defaults to `omitted` (empty thinking text); `display: 'updates'` (beta) returns between-tool progress notes | all three |
| R9 | Mid-conversation `{ role: 'system' }` messages are accepted (no beta) and keep the cached prefix | Sonnet 5.5, Haiku 5.5, Opus 5.5 |
| R10 | Prompt caching reports `usage.cache_read_input_tokens` / `cache_creation_input_tokens` | all three |
| R11 | Server-side refusal fallback on Sonnet 5.5: `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01` (Claude API only) | Sonnet 5.5 |

## Scope

**In:**
- A spike script that exercises R1–R11 through `ChatAnthropic` and records, for each, whether the **outgoing request body** and the **parsed response** are correct.
- The same calls through `@anthropic-ai/sdk` 0.131 as the control, so a failure can be pinned on the binding rather than the API.
- Two LangChain features the graph depends on: `bindTools` with Zod schemas (strict), and streaming (`.stream()` / `streamEvents`) carrying text, tool calls and thinking blocks.
- The `@langchain/core` / `deepeval` version question: does `deepeval` 0.9.22 import and run its basic metric against `@langchain/core` 1.2.17?
- The decision, written into this spec's decision log and into `tech-stack.md` Layer 3.

**Out:**
- The other M1 items — Vercel streaming and duration, interrupt/resume across requests, config and `.env.example` — each get their own spec.
- Any production code under `src/`. The spike is throwaway.
- Tuning effort levels or prompts.

## Design

**Location:** `spikes/001-binding-check/` at the backend root. `tsconfig.json` builds only `src/**`, so nothing here ships. Add `spikes` to `globalIgnores` in `eslint.config.mjs` so throwaway code doesn't fail `npm run lint`. Run with `npx tsx spikes/001-binding-check/run.ts`.

**Request capture:** both clients get a custom `fetch` (LangChain: `clientOptions: { fetch }`; SDK: `new Anthropic({ fetch })`) that records each request's JSON body and the raw response before returning it. Every check asserts on the **wire**, not on what the library claims to send.

**How each option is passed to `ChatAnthropic`:** try first-class constructor/call options; if none exists, fall back to `invocationKwargs` (merged into the request body). Record which path worked — a rule that only works via `invocationKwargs` is a pass with a note, since the graph can pass it the same way.

**Checks** (one function each; result `pass` / `pass-with-note` / `fail` + evidence):

| Check | Model | What it does | Pass when |
|---|---|---|---|
| C1 thinking + effort | Sonnet 5.5 | one call with `thinking: { type: 'adaptive' }`, `output_config: { effort: 'low' }` | body contains both exactly; 200; no `budget_tokens` anywhere in the body |
| C2 effort defaults | Haiku 5.5, Opus 5.5 | same, effort `low` | body has the explicit effort |
| C3 strict tools | Sonnet 5.5 | `bindTools([zodTool], { strict: true })`, prompt that needs the tool | body tool has `strict: true`, `additionalProperties: false`, `required`; response parsed into `tool_calls` with valid args |
| C4 tool_choice | Sonnet 5.5 | `bindTools` with no `tool_choice`, then with `'auto'` | body has `auto` or omits it; confirm the binding never injects `any`/`tool` on its own (e.g. in `withStructuredOutput`) |
| C5 refusal | Sonnet 5.5 | mocked response (`stop_reason: 'refusal'`, `stop_details` set) served by the capture `fetch` | `stop_reason` and `stop_details.category` are readable from the `AIMessage` (`response_metadata` or `additional_kwargs`). A live refusal isn't provoked on purpose |
| C6 thinking round-trip | Sonnet 5.5 | turn 1 with a tool call → tool result → turn 2, history built from LangChain messages | turn-2 body contains turn 1's thinking block byte-identical (including `signature`); 200 |
| C7 model switch | Sonnet 5.5 → Opus 5.5 | replay C6's history to Opus 5.5 | 200; the binding doesn't strip or rewrite the blocks itself |
| C8 display updates | Sonnet 5.5 | `thinking: { type: 'adaptive', display: 'updates' }` + beta header, multi-tool prompt | progress-note thinking blocks reach the `AIMessage` / stream chunks |
| C9 mid-conversation system | Sonnet 5.5 | `SystemMessage` placed after a user message | body keeps it in `messages` with `role: 'system'` (not merged into top-level `system`, not rejected) |
| C10 caching | Sonnet 5.5 | same long static system prompt + tools twice, `cache_control` on the system block | second call reports `cache_read_input_tokens > 0` in `usage_metadata` / `response_metadata` |
| C11 fallbacks | Sonnet 5.5 | `fallbacks: 'default'` + beta header | body carries both; 200 |
| C12 streaming | Sonnet 5.5 | `.stream()` and `streamEvents` on a tool-using prompt | text deltas, tool-call chunks and thinking blocks all arrive; the final aggregated message equals the non-streamed shape |
| C13 deepeval | — | import `deepeval`, run one deterministic metric in Vitest | imports and runs without a `@langchain/core` error |

Each check runs against the SDK control too (C1–C4, C6–C11); the C5 refusal is mocked for both.

**Output:** `spikes/001-binding-check/results.md` — one row per check with result, evidence (the relevant body fragment) and the path used (first-class / `invocationKwargs`). Copied into this spec's results section when done.

**Decision rule:**
- **Use `ChatAnthropic`** if C1, C3, C4, C5, C6, C9 and C12 pass (with or without notes). The others (C7, C8, C10, C11) can be worked around inside the node.
- **Use `@anthropic-ai/sdk` in a custom node** if any of those seven fail and can't be fixed by upgrading `@langchain/anthropic` to a release whose nested SDK is ≥ 0.131. The custom node still returns LangChain `AIMessage`s so `ToolNode`, the checkpointer and `interrupt()` work unchanged.
- **deepeval (C13):** if it fails, evals run deepeval in its own package (`evals/package.json`) with its pinned `@langchain/core`, isolated from the app.

**Cost:** ~25 live calls, mostly Sonnet 5.5 at effort `low` with short prompts. Expected well under $1.

## Tasks

- [ ] `npm ci --legacy-peer-deps` in the backend; confirm the versions in the Context table
- [ ] Add `spikes` to `globalIgnores` in `eslint.config.mjs`
- [ ] Capture `fetch` + result recorder (`spikes/001-binding-check/capture.ts`)
- [ ] Checks C1–C12 against `ChatAnthropic` and the SDK control
- [ ] C13 deepeval import/run
- [ ] Write `results.md`
- [ ] Apply the decision rule; record it in the decision log
- [ ] Update `tech-stack.md` Layer 3 "Binding check" with the outcome
- [ ] Update the `docs/spec/README.md` index and this spec's status

## Acceptance criteria

- [ ] Every check C1–C13 has a result with evidence in `results.md` — verified by reading it
- [ ] For every failing check, the SDK control shows whether the fault is the binding or the API — verified in `results.md`
- [ ] The binding decision is stated in the decision log with the checks it rests on
- [ ] `tech-stack.md` Layer 3 says which binding M2 uses
- [ ] `npm run lint` and `npm run build` still pass (spike code is excluded from both) — verified by running them

## Test plan

This spec is itself a test. Each acceptance criterion is checked by running `npx tsx spikes/001-binding-check/run.ts` once with `ANTHROPIC_API_KEY` set, then reading `results.md`. C5 and C13 need no API key.

## Open questions

- **API key:** `ANTHROPIC_API_KEY` must be available where the spike runs. Run it in this cloud session (set the key as an environment secret) or locally?
- **Spike code after the decision:** delete `spikes/001-binding-check/` once the spec closes (results kept here), or keep it as a regression check to rerun when `@langchain/anthropic` is upgraded? Recommendation: keep it — it's the cheapest way to re-verify an upgrade.

## Results

_Filled in when the checks run._

## Decision log

| Date | Decision | Why |
|---|---|---|
