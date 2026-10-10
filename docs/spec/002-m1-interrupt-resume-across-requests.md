# 002 — Interrupt and resume across requests

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M1 — Spikes & foundations ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | `6ec320b` |

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

- [x] Local MongoDB 7 for the spike (Docker), `MONGO_URL` override
- [x] `graph.ts` (scripted agent, gate, tool with DB side effect, gate-entry counter)
- [x] `request.ts` (one call per process: `setup`, `start`, `resume-yes`, `resume-no`, `resume-yes-guarded`, `stream-start`, `stream-resume-yes`)
- [x] `run.ts` driving I1–I9; writes `results.md`
- [x] I6 showed double execution: claim guard implemented and tested in the spike (`race.ts`)
- [x] Record the M2/M4 rules in the decision log; update `architecture.md` §3 (plus `phases.md` §2/M4 and `security.md` §6)
- [x] Update `phases.md` §0 and the spec index

## Acceptance criteria

- [x] I1–I9 each have a result with evidence in `results.md` — verified by reading it
- [x] I2 shows the tool running exactly once, from a process that never saw the pause — with both the mongoose client and the checkpointer's own client
- [x] The rule for duplicate confirms is decided, with a tested guard — I6: 20/20 double runs without it, 20/20 single runs with it
- [x] The connection choice and a checkpoint TTL are decided — the app's mongoose client; 30 days
- [x] `npm run lint`, `npm run build` and `npm test` still pass — lint 0 errors (106 existing `any` warnings), build clean, 51/51 tests

## Test plan

`run.ts` is the test: it drives every check through separate processes (I6 through `race.ts`, see below) and asserts on MongoDB counts, so results don't depend on in-memory state. Run from `mern-backend/` with MongoDB up:

```bash
docker run -d --name spike-mongo -p 27017:27017 mongo:7   # or set MONGO_URL
npx tsx spikes/002-interrupt-resume/run.ts
```

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**Run 2026-10-10** against MongoDB 7.0 — full evidence in [`spikes/002-interrupt-resume/results.md`](../../spikes/002-interrupt-resume/results.md).

| Check | Result | What it showed |
|---|---|---|
| I1 pause | pass | `invoke` returns `__interrupt__: [{ id, value: { tool, args, summary } }]`; `getState().next` is `['gate']`; the tool hasn't run |
| I2 resume in another process | pass | a new process with a new client, checkpointer and graph resumes; the tool runs exactly once; resume took ~150–190 ms locally (~35 ms of it connecting). Same result with the mongoose client (driver 7) and the checkpointer's own client (driver 6) |
| I3 declined | pass | the tool never runs; the agent gets the decline `ToolMessage` and answers |
| I4 gate re-entry | finding | the gate node starts **twice** per confirmation — once to pause, once on resume |
| I5 duplicate confirm, sequential | pass | resuming a finished turn is a silent no-op: same final state, tool not re-run |
| I6 duplicate confirm, concurrent | **finding → guard** | two confirms on the same tick, from independent clients and graphs: **the tool ran twice in 20 of 20 rounds**. With the claim guard (unique insert of the interrupt id before resuming): once in 20 of 20; the loser gets "already confirmed". (Separate processes hid this at first: ~1 s of start-up jitter meant they never overlapped, so I6 uses `race.ts`) |
| I7 nothing pending | finding | resuming an unknown or finished thread returns normally with nothing done — no error. The claim guard turns it into "nothing pending" |
| I8 streaming | pass | with `streamMode: ['updates', 'messages']` the pause arrives as an `updates` chunk keyed `__interrupt__` (with the id and value); the resumed stream carries the tool message and the final text |
| I9 connection and lifetime | pass | (a) `MongoDBSaver` works on mongoose's client despite bundling driver 6 types (needs a type cast); (b) `setup()` with `ttl` creates `upserted_at` TTL indexes (2,592,000 s) on both collections; (c) one confirmed turn ≈ 12 KB (6 checkpoint docs, 7.6 KB; 12 write docs, 4.3 KB) |

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved. Checkpoints expire after **30 days** of inactivity (`ttl: 2_592_000`) | Long enough to return to a chat; bounds storage and stored personal data |
| 2026-10-10 | **The checkpointer uses the app's mongoose client** (`mongoose.connection.getClient()`, cast to the checkpointer's `MongoClient` type) | Works at runtime on driver 7 (I2, I9a) and avoids a second connection pool per serverless instance |
| 2026-10-10 | `checkpointer.setup()` runs once per environment (a deploy-time script), not per request | It creates indexes; the TTL ones need it (I9b) |
| 2026-10-10 | **Rule: nothing with a side effect goes before `interrupt()`.** The gate only decides; tools run in the tool node after it | The gate node re-runs from its start on resume (I4) |
| 2026-10-10 | **A confirm claims its interrupt before resuming** — unique insert of the interrupt id into a `confirm_claims` collection (with the same 30-day TTL); the loser answers "already confirmed", and a resume with nothing pending answers "nothing to confirm". Built for real in M4 | Without it, concurrent confirms run the tool twice every time (I6); with it, exactly once. Plain resumes on finished or unknown threads fail silently (I5, I7), so the endpoint must check |
| 2026-10-10 | The SSE `confirm_required` event carries `interruptId`, and the resume request sends it back: `{ threadId, resume: { interruptId, approved } }` | The claim needs the id; `__interrupt__` already provides it in both invoke and stream results (I1, I8). Recorded in `phases.md` §2 |
| 2026-10-10 | M2 streams with `streamMode: ['updates', 'messages']` | `updates` carries `__interrupt__` for `confirm_required`; `messages` carries tokens and tool messages (I8) |
| 2026-10-10 | Known limit, accepted: if the request that won the claim dies before the tool runs, that confirmation is lost and the customer asks again | Rare, and safe — the failure mode is "nothing happened", never "it happened twice" |
