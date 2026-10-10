# 008 — Confirmation gate and cart writes

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M4 — Write tools + confirmation gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |

## Goal

The agent can change the customer's cart, and any action that needs a "yes" pauses for it. `add_to_cart` and `update_cart_item` run straight away; `clear_cart` pauses with a server-written summary until the customer confirms through a resume request, and a confirmation can run the action at most once.

## Context

- **Rule:** any write that is irreversible, bulk, account-changing or external needs an explicit "yes" ([`security.md`](../shopping-agent/security.md) §6). Single-item cart edits are exempt; `clear_cart` is bulk.
- **Spec 002** proved pause and resume across requests, and set three rules:
  - nothing with a side effect before `interrupt()`
  - claim the interrupt id before resuming (without that, 20 of 20 concurrent confirms ran the tool twice)
  - `confirm_required` carries `interruptId`
- **Spec 006** already maps `__interrupt__` to `confirm_required` and keeps every `tool_use` answered.
- **Store services** used here: `addToCart`, `updateCartItem` (0 removes) and `clearCart` in `src/services/cart.service.ts`, all keyed by `userId`. The `confirm_claims` TTL index comes from `npm run agent:setup` (spec 003).
- **M4 split** (approved plan; one spec at a time):

| Spec | Delivers |
|---|---|
| **008** | the gate, resume and cart writes |
| 009 | the confirm card |
| 010 | `place_order` |
| 011 | profile and support |
| 012 | avatar upload |
| 013 | `cancel_order` |

## Scope

**In:**
- Three cart write tools.
- A gate node in the graph.
- The resume request on the existing endpoint, with the claim guard.
- An audit log of confirmations and writes.
- A prompt update and prompt versioning of conversations.

**Out:**
- The frontend confirm card (009). Until it ships, `AGENT_ENABLED` stays off.
- The other write tools (010–013).
- Per-user rate limits (M6).

## Design

**Tools** (`src/agent/tools/`):

| Tool | Arguments | Calls | Confirm |
|---|---|---|---|
| `add_to_cart` | `product_id` (24-hex), `quantity` 1–99 (default 1) | `addToCart(ctx.userId, …)` | no |
| `update_cart_item` | `product_id`, `quantity` 0–99 (0 removes) | `updateCartItem(ctx.userId, …)` | no |
| `clear_cart` | none | `clearCart(ctx.userId)` | **yes** — summary "Remove all N items ($X) from your cart?" from the current cart |

- Each returns the cart in `view_cart`'s shape (shared `cartSummary()` in `helpers.ts`).
- Known service errors become plain `{ error }` messages: not enough stock, product not found, item not in cart.
- Metadata is `{ kind: 'write', confirmRequired }`.
- Confirm-required tools have a read-only summary function, used by the gate through `summarizeConfirmation(call, ctx)`.

**Graph:** `agent → route → (END | budget_exceeded | gate | tools)`.
- **Gate:**
  - It reads only before `interrupt({ tool, args, summary })`.
  - On resume, `{ approved: true }` goes to `tools`; anything else answers every pending call with "The customer declined" and goes back to `agent`.
  - Two or more confirm-required calls in one message: none run, and each gets "Ask for one of these at a time".
  - Confirm-required tools are found from tool metadata, so the graph doesn't depend on the tools module.

**Resume** — same `POST /api/v1/agent/chat`, body `{ threadId, resume: { interruptId, approved } }`. Steps:
1. Check that the thread has a pending interrupt with that id; if not → `error` "There's nothing waiting for confirmation." + `done`.
2. Claim the id: a unique insert into `confirm_claims`. If it's already claimed → `error` "That was already confirmed." + `done`.
3. Stream `Command({ resume: { approved } })`.

The claim function is injected (`ChatDeps.claimConfirmation`). The default writes to MongoDB.

**Audit log** (ids and quantities only):
- `AGENT_CONFIRMATION { userId, thread, tool, toolCallId, decision }`, logged after the interrupt resumes.
- `AGENT_WRITE { userId, thread, tool, toolCallId, confirmRequired, outcome }`, logged by the tools node.

**Prompt versioning:**
- The checkpoint key becomes `<userId>:<threadId>:v<PROMPT_VERSION>`. A changed system prompt or tool list mid-conversation would invalidate earlier thinking blocks ([`tech-stack.md`](../shopping-agent/tech-stack.md) Layer 3), so a prompt change starts conversations fresh on the server.
- This spec sets `PROMPT_VERSION = 2`.

## Tasks

- [x] `cartSummary()` shared helper; the three tools (`cart-writes.ts`); `summarizeConfirmation`; tool labels
- [x] Gate node, routing, declined/multiple handling, audit logging
- [x] Resume request: schema union, pending check, claim, `Command` resume
- [x] `PROMPT_VERSION` in the checkpoint key; prompt text
- [x] Tests (below)
- [x] Update `phases.md` §0 and the spec index

## Acceptance criteria

- [x] `add_to_cart` / `update_cart_item` run without a pause; `clear_cart` pauses with the server-computed summary and changes nothing until confirmed — graph tests
- [x] Approved → `clearCart` runs once; declined → never runs and every pending call is answered — graph and HTTP tests
- [x] Two confirm-required calls in one message → neither runs (nor anything else in that message) — graph test
- [x] Over HTTP: `confirm_required` carries `interruptId`; resuming streams the result; a claim already taken gets "already confirmed"; a wrong id, a finished turn or another user's thread gets "nothing waiting"; a malformed resume body gets 400 — HTTP tests
- [x] Two **concurrent** resumes against MongoDB run `clear_cart` once — HTTP test with the real `confirm_claims` claim
- [x] No tool schema has an identity field; only `clear_cart` is confirm-required; quantity bounds hold; service errors are plain — tool tests
- [x] `npm run lint` (0 errors), `npm run build`, `npm test` pass with and without `MONGO_URL`

## Test plan

- **Graph and tool unit tests:** scripted model, mocked services.
- **HTTP tests:** the existing route test setup with an in-memory claim.
- **Concurrent resumes:** a MongoDB block using the real `confirm_claims` claim (skips without `MONGO_URL`).

## Open questions

_None — the split and order were approved with the M4 plan._

## Results

**2026-10-10**
- `npm test`: 113 passed, 8 skipped without MongoDB; with `MONGO_URL` (local MongoDB 7): **121/121**.
- New tests: 6 cart-write tool tests; 5 gate tests in `graph.test.ts`; 7 HTTP tests, one of them the concurrent-confirm test against MongoDB.
- Lint 0 errors (106 existing warnings); build clean. The real app still answers 503 while `AGENT_ENABLED` is off, including for a resume body.

What a turn looks like over SSE:

| Request | Events |
|---|---|
| `{ message: "empty my cart" }` | `confirm_required { interruptId, tool: "clear_cart", summary: "Remove all 2 items ($90.00) from your cart?" }` → `done` |
| `{ threadId, resume: { interruptId, approved: true } }` | `tool_start` → `tool_end` → `token`… → `done` |
| same, `approved: false` | `token`… ("Okay, I left your cart as it is.") → `done` |
| same again after it finished | `error` "There's nothing waiting for confirmation." → `done` |

Files: `src/agent/tools/cart-writes.ts` (new), `tools/{helpers,types,index,view-cart}.ts`, `src/agent/{graph,chat.service,checkpointer,stream,prompt,config}.ts`, `src/controllers/agent.controller.ts`, and the tests.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved with the M4 plan: gate first; `cancel_order` last (013) | Owner's choice |
| 2026-10-10 | Confirm-required tools get no `tool_start` until the customer confirms; on an approved resume the service sends `tool_start` for the confirmed tool first | Otherwise the chat would show "Clearing your cart…" before anything was confirmed |
| 2026-10-10 | When one message asks for two confirm-required actions, nothing in that message runs — the auto writes included — and every call gets "ask for one of these at a time" | One "yes" must map to one action; partly running a message the customer didn't approve as a whole would be surprising |
| 2026-10-10 | A resume for a turn that already finished gets "nothing waiting", not "already confirmed" | The pending check runs before the claim; both are non-retryable and run nothing |
| 2026-10-10 | `AGENT_CONFIRMATION` is logged after `interrupt()` returns | Before it, the node runs twice (pause and resume) and would log twice |
| 2026-10-10 | The graph finds confirm-required tools from their metadata, and summaries come in through `deps.summarize` | Keeps the graph independent of the tools module; tests pass stand-in tools |
