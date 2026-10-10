# 002 — Interrupt and resume across requests

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M1 — Spikes & foundations ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |

## Goal

Prove that a LangGraph turn paused at `interrupt()` in one HTTP request can be resumed in a different request — a different process, with nothing kept in memory — using `MongoDBSaver`, and settle the rules M2 and M4 must follow for that to be safe: where side effects go, what a duplicate or late "Confirm" does, how a pause appears in a stream, how long checkpoints live, and which MongoDB connection the checkpointer uses.

## Context

- The confirmation gate is a security control ([`security.md`](../shopping-agent/security.md) §6): `place_order`, `cancel_order`, `clear_cart`, `update_profile`, `upload_avatar` and `submit_support_request` run only after an explicit "yes".
- The backend runs as a Vercel serverless function, so the request that pauses and the request that resumes can land on different instances. [`reconciliation.md`](../shopping-agent/reconciliation.md) Gap 14 decides that `interrupt()`/resume goes through the Mongo checkpointer, never in-process state, and [`phases.md`](../shopping-agent/phases.md) M1 item 4 asks for proof.
- Spec 001 chose `ChatAnthropic`; this spec doesn't need a model at all. The agent node is scripted, so the check runs without an API key.

**What the installed packages show:**

| Package | Installed | Note |
|---|---|---|
| `@langchain/langgraph` | 1.4.20 | `interrupt()`, `Command({ resume })` |
| `@langchain/langgraph-checkpoint-mongodb` | 1.4.2 | `MongoDBSaver({ client, dbName, ttl })`; `setup()` creates indexes, and TTL indexes when `ttl` is set |
| its `mongodb` driver | 6.x, nested | mongoose 9.0.2 uses driver **7.x**. Whether the checkpointer can take mongoose's client is open (check I9) |

**LangGraph behaviour this spec has to pin down:** on resume, the node that called `interrupt()` runs again **from its start**, with `interrupt()` now returning the resume value. Anything before the `interrupt()` call in that node runs twice.

## Scope

**In:**
- A spike graph shaped like the M4 design: agent node (scripted) → confirm-gate node (`interrupt()` for confirm-required tools) → tool node → agent node, with `MongoDBSaver` as the checkpointer.
- Checks I1–I9 below, against a real MongoDB 7.
- Rules for M2/M4, written into the decision log and into [`architecture.md`](../shopping-agent/architecture.md) §3 where they change the design.

**Out:**
- The HTTP endpoint and SSE encoding (M2). The spike calls the graph directly; a "request" is one graph call in its own process.
- Vercel streaming and duration (its own M1 spec; needs a deployment).
- Real tools and a real model.

## Design

**Location:** `spikes/002-interrupt-resume/`, same conventions as spec 001 (outside `src/`, ignored by ESLint, run with `npx tsx`).

**MongoDB:** a local `mongo:7` container (`docker run -d -p 27017:27017 mongo:7`), database `spike_002`, dropped at the start of each run. `MONGO_URL` overrides it, so the same run works against an Atlas dev database. Atlas-only features aren't needed here.

**Graph** (`graph.ts`):

```
START → agent → gate → tools → agent → END
```

- `agent`: scripted. First call returns an `AIMessage` with one tool call (`clear_cart` — confirm-required); after a tool result, returns a final text message.
- `gate`: if the pending tool call is confirm-required, calls `interrupt({ tool, args, summary })`. On resume it reads `{ approved: boolean }`. Approved → continue to `tools`; declined → append a `ToolMessage` ("The customer declined.") and go back to `agent` without running the tool.
- `tools`: runs the tool. The tool's only side effect is inserting one document into a `spike_effects` collection, so every check can count executions in the database rather than in memory.
- A counter collection `spike_gate_entries` records every time `gate` starts executing, to make the "node re-runs on resume" behaviour visible.

**Process boundary:** every "request" is `npx tsx request.ts <action> <threadId> [json]` in a **separate child process**, which builds a new `MongoClient`, a new `MongoDBSaver` and a new compiled graph, does one call, prints JSON, and exits. Nothing is shared between requests except MongoDB.

**Checks:**

| # | Check | Pass when |
|---|---|---|
| I1 | Pause | Request A `invoke`s with a new `thread_id`; the result carries `__interrupt__` with `{ tool: 'clear_cart', summary }`; `spike_effects` count is 0 |
| I2 | Resume approved, in another process | Request B (new process) sends `Command({ resume: { approved: true } })` on the same `thread_id`; the tool runs; `spike_effects` count is exactly 1; final state ends with the agent's text |
| I3 | Resume declined | New thread: pause, then resume `{ approved: false }`; `spike_effects` count is 0; the agent receives the decline `ToolMessage` and finishes |
| I4 | Gate re-entry | `spike_gate_entries` shows the gate node starting twice for one confirmation (pause + resume). Recorded as fact for the rule "nothing with a side effect goes before `interrupt()`" |
| I5 | Duplicate "Confirm", sequential | After I2 completes, the same resume is sent again; the tool does **not** run a second time (`spike_effects` still 1). Record what the second call returns |
| I6 | Duplicate "Confirm", concurrent | New thread paused; two processes send the resume at the same moment. Record how many times the tool runs. **If it can run twice**, the spike also implements and tests the mitigation in the Design note below |
| I7 | Resume with nothing pending | Resume on a thread with no pending interrupt, and on an unknown `thread_id`; record the behaviour so M2 can map it to an `error` event |
| I8 | Pause and resume while streaming | Same as I1–I2 with `graph.stream(…, { streamMode: ['updates', 'messages'] })`: the interrupt appears as a stream chunk M2 can turn into `confirm_required`, and the resumed stream carries the tool result and the final text |
| I9 | Connection and lifetime | (a) Can `MongoDBSaver` use the client from the app's mongoose connection (`mongoose.connection.getClient()`, driver 7) instead of opening a second pool? (b) `setup()` with `ttl` creates TTL indexes on both collections. (c) Size of the checkpoint documents for one confirmed turn |

**Design note — duplicate confirms (I6).** If two concurrent resumes can both run the tool, M4 needs a claim step that only one request can win, e.g. before resuming, atomically mark the interrupt id as used in Mongo (`findOneAndUpdate({ threadId, interruptId, used: false }, { used: true })`) and answer the loser with "already confirmed". The spike tests whichever guard is needed; the M4 spec builds it for real.

**Output:** `results.md` next to the spike, one row per check with evidence (counts, returned shapes, index list, timings).

## Tasks

- [ ] Local MongoDB 7 for the spike (Docker), `MONGO_URL` override
- [ ] `graph.ts` (scripted agent, gate, tool with DB side effect, gate-entry counter)
- [ ] `request.ts` (one call per process: `start`, `resume`, `stream-start`, `stream-resume`)
- [ ] `run.ts` driving I1–I9 through child processes; writes `results.md`
- [ ] If I6 shows double execution: implement and test the claim guard in the spike
- [ ] Record the M2/M4 rules in the decision log; update `architecture.md` §3 if the confirmation flow changes
- [ ] Update `phases.md` §0 and the spec index

## Acceptance criteria

- [ ] I1–I9 each have a result with evidence in `results.md` — verified by reading it
- [ ] I2 shows the tool running exactly once, from a process that never saw the pause — the core M1 question
- [ ] The rule for duplicate confirms is decided, with a tested guard if I6 needs one
- [ ] The connection choice (shared mongoose client or own client) and a checkpoint TTL are decided
- [ ] `npm run lint`, `npm run build` and `npm test` still pass

## Test plan

`run.ts` is the test: it drives every check through separate processes and asserts on MongoDB counts, so results don't depend on in-memory state. Run from `mern-backend/` with the container up: `npx tsx spikes/002-interrupt-resume/run.ts`.

## Open questions

- **Checkpoint lifetime:** how long should a conversation's checkpoints live? Recommendation: 30 days of inactivity (`ttl: 2_592_000`) — long enough to return to a chat, short enough to bound storage and stored PII. The spike only checks that TTL works; the number is a product call.

## Results

_Filled in when the checks run._

## Decision log

| Date | Decision | Why |
|---|---|---|
