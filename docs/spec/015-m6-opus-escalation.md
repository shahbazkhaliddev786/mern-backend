# 015 — Opus escalation for stuck turns

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M6 — Hardening ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |
| **Repo** | `mern-backend` only |

## Goal

When a turn gets stuck — the step budget runs out, the agent repeats the same call, or a tool keeps failing — the rest of that turn is handed to Claude Opus 5.5 once, with the same tools and the same confirmation gate. If Opus gets stuck too, or the customer's escalation budget is spent, the agent stops and offers to pass the request to human support. Normal turns never escalate.

## Context

- **Design:**
  - [`architecture.md`](../shopping-agent/architecture.md) §3 step 8 and the escalation-model row: Opus only on stuck turns, same tools and gate, "not a second agent".
  - [`reconciliation.md`](../shopping-agent/reconciliation.md) Gap 4: the three triggers, escalate **once**, emit `reason: loop | step_budget | repeated_tool_error`.
  - [`tech-stack.md`](../shopping-agent/tech-stack.md) Layer 3: Opus can't read Sonnet's thinking blocks; the API drops them unbilled and Opus re-plans from the visible history. Pass them back unchanged.
  - [`security.md`](../shopping-agent/security.md) §10: a separate per-user budget for escalations.
  - [`evals.md`](../shopping-agent/evals.md): trigger precision ≥ 0.9, resolve rate ≥ 0.7 (measured in M7).
- **What exists:**
  - `buildAgentGraph` (specs 006, 008): `agent → route → (END | budget_exceeded | gate | tools)`. At the step budget (8 tool calls in a turn) it answers every pending call and replies with `STEP_BUDGET_REPLY`.
  - `AGENT_MODELS.escalation` (`claude-opus-5-5`) and `AGENT_EFFORT.escalation` (`medium`) in `config.ts`, unused so far.
  - The per-user limiters from spec 014, which this spec gives a fifth budget.
  - Refusals are already handled per model call (`stop_reason: 'refusal'`).

## Scope

**In:**
- Stuck detection for the three triggers.
- Handing the rest of the turn to Opus.
- The per-user escalation budget.
- The support offer when Opus is stuck too or the budget is spent.
- Audit logs carrying the reason and the outcome.
- A status label while Opus works.

**Out:**
- The LLM-judged escalation evals (trigger precision, resolve rate): those are M7's eval gate. This spec covers the trigger logic with deterministic tests.
- Tracing spans and cost per escalated turn (017).
- Escalating anything other than a stuck turn (e.g. "hard" questions up front).

## Design

**What "retry on Opus" means here** — the turn **continues** on Opus. It doesn't rewind.
- **Why not rewind:** steps the turn already took may have changed something (an `add_to_cart` that ran is in the cart). Replaying the turn from the customer's message would hide that from Opus, and it might do it again. Rewinding would also edit the stored history, which the append-only rule forbids.
- **What Opus gets:** the whole visible history, including what Sonnet tried and the errors it got, so it can see what didn't work. That matches architecture.md ("re-plans the turn from the visible history").
- **Sonnet's thinking blocks** stay in the history unchanged. The API drops them for Opus (tech-stack.md Layer 3).

**Turn state** (`AgentState`, reset with each new message, like `toolCalls` today):
- `escalated: boolean`: Opus has taken over this turn.
- `turnCalls: { key: string; tool: string; error: boolean }[]`: the calls this turn has run, where `key` is the tool name plus its arguments with sorted keys.
- `toolCalls` counts per model: it restarts at 0 when Opus takes over, so Opus gets the same budget of 8.

**Triggers** (checked in `route` before calls run, and after the tools node):

| Reason | Stuck when | Checked |
|---|---|---|
| `step_budget` | The next calls would pass 8 tool calls for the current model | In `route`, before running them |
| `loop` | A call identical (same `key`) to one already made **twice** in this turn: the third identical call | In `route`, before running it |
| `repeated_tool_error` | The same tool returns an error twice in a row in this turn | After the tools node |

- **Two identical calls are allowed,** since retrying once after a transient error is reasonable; the third is stuck.
- **What counts as a tool error:** only errors from running the tool. These don't count:
  - the gate's answers ("Not run: the customer declined", "ask for one of these at a time")
  - per-user limit refusals (spec 014): retrying won't help, and Opus would hit the same limit
  - The limit refusals get marked with `limited: true` in their result so they can be told apart.
- **Pending calls get answered.** When a trigger fires before calls run (`step_budget`, `loop`), each pending call gets *"Not run: handing this over."*, so the history stays valid (every `tool_use` answered).

**Escalation** (new node `escalate`):
1. **Not yet escalated this turn:**
   - It takes one point from the `escalations` budget: 10 per account per day.
   - **Points left:** it sets `escalated: true` and resets `toolCalls`, then goes back to `agent`, which now calls the Opus model. Opus has the same tools (bound with `strict: true`), the same system prompt block and the same gate.
   - **Budget spent, or the limit store fails:** it goes to `give_up`.
2. **Already escalated** (Opus is stuck too) → `give_up`.

**`give_up`** answers any pending calls and replies with a fixed message:
> *"I couldn't finish that, sorry. I can send your request to our support team: just say "contact support". Or reach us from the Contact page (/contact)."*

The customer's next message runs on Sonnet as usual. "contact support" leads to `submit_support_request`, which still needs their confirmation.

**Models:**
- `AgentGraphDeps` gains `escalationModel?: BaseChatModel`. Without it, a stuck turn goes straight to `give_up`, so existing tests and setups keep working.
- `createEscalationModel(config)`: `AGENT_MODELS.escalation`, thinking `adaptive`, effort `AGENT_EFFORT.escalation` (`medium`), the same `maxTokens`.
- `ChatDeps` gains `createEscalationModel`.
- The `agent` node picks the model by `state.escalated`. Refusal handling is unchanged.

**Streaming:**
- When Opus takes over, the stream sends `tool_start { tool: 'escalation', label: 'Taking a closer look…' }`. The chat panel shows any `tool_start` label until the next token, so no frontend change is needed.
- `give_up` is a speaking node: its reply streams as tokens, like `budget_exceeded`.

**Audit log** (ids only):
- `AGENT_ESCALATION { userId, thread, reason, outcome }`, where `outcome` is `escalated`, `over_budget` or `no_model`.
- `AGENT_TURN_STOPPED { userId, thread, reason, escalated }` from `give_up`.
- An escalated turn that finishes normally logs `AGENT_ESCALATION_RESOLVED { userId, thread, reason, toolCalls }`.

The `budget_exceeded` node and `STEP_BUDGET_REPLY` are replaced by `escalate` and `give_up`.

## Tasks

- [x] `AgentState`: `escalated`, `turnCalls`; chat service resets them per message
- [x] Trigger checks in `route` and after `tools`; `limited: true` on limit refusals (`write-limit.ts`)
- [x] `escalate` and `give_up` nodes; `escalationModel` in the graph; `createEscalationModel`; `ChatDeps`
- [x] `escalations` budget in `limits.ts`
- [x] Stream: escalation status, `give_up` as a speaking node
- [x] Audit logs
- [x] Tests (below)
- [x] Update `security.md` §10 (the escalation budget), `phases.md` §0 and the spec index

## Acceptance criteria

- [x] **Each trigger escalates with the right reason, and Opus finishes the turn:**
  - [x] 9 tool calls in a turn → `step_budget`.
  - [x] A third identical call → `loop`, and the third call isn't run.
  - [x] The same tool erroring twice in a row → `repeated_tool_error`.
  - [x] In each case Opus answers, and the second model's calls go to the Opus model.
  - [x] Covered by graph tests.
- [x] **Normal turns never escalate:**
  - [x] two identical calls
  - [x] one tool error, then success
  - [x] errors from different tools
  - [x] a declined confirmation
  - [x] a per-user limit refusal twice
  - [x] 8 calls exactly
  - [x] Covered by graph tests.
- [x] **Escalates once:** Opus stuck as well → `give_up` with the support offer, and no third model — graph test
- [x] **Same tools and gate:** a confirm-required call made by Opus pauses for confirmation and runs only on approval — graph test
- [x] **Budget:** with the escalation budget spent, a stuck turn goes straight to `give_up` and Opus isn't called; a limit-store failure does the same — graph tests
- [x] **History stays valid:** every `tool_use` in an escalated or given-up turn has a result — graph test
- [x] **The request sent to Opus:** model `claude-opus-5-5`, adaptive thinking, effort `medium`, strict tools, no `tool_choice`, and the cached system prompt first — request-capture test
- [x] **Over HTTP:**
  - [x] An escalated turn streams `tool_start { tool: 'escalation' }`, then Opus's answer.
  - [x] A given-up turn streams the support offer as tokens.
  - [x] Covered by HTTP tests.
- [x] **Audit logs** carry the reason and outcome, and no message text — test
- [x] **Checks:** backend lint 0 errors, build, `npm test` 189 + 30 skipped / 219 with `MONGO_URL` and `ATLAS_URL`

## Test plan

- **Graph:** two `ScriptedChatModel`s (Sonnet and Opus) and recording tools, one tool scripted to keep erroring.
- **Request capture:** like spec 006's test.
- **HTTP:** the `agent.routes.test.ts` setup with an escalation model in `deps`.
- **Not in this spec:** the LLM-judged stuck/normal eval split (M7) and a real-model run (parked with the API key).

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**2026-10-10** — backend only.
- **Files:**
  - `src/agent/graph.ts`: turn state, triggers, the `escalate` and `give_up` nodes, `createEscalationModel`
  - `chat.service.ts`: the escalation model and budget check, plus the per-turn reset
  - `stream.ts`: the status label; `give_up` speaks
  - `limits.ts`: the `escalations` budget
  - `tools/write-limit.ts`: limit refusals are marked `limited`
  - `prompt.ts`: `GIVE_UP_REPLY` replaces `STEP_BUDGET_REPLY`
- **New tests (12):** 9 graph tests, covering:
  - the three triggers
  - five normal-turn scenarios that don't escalate
  - a declined confirmation
  - Opus stuck too
  - the gate under Opus
  - the budget being spent
  - the request sent to Opus

  Plus 3 HTTP tests. Two existing graph tests now use distinct arguments, since identical calls are a loop now.
- **Request to Opus** (captured): `claude-opus-5-5`, the cached system prompt first, adaptive thinking, effort `medium`, strict tools, no `tool_choice`, and the whole visible history.
- **Not yet seen:** a real Opus turn after a Sonnet one, including the API dropping Sonnet's thinking blocks as tech-stack.md describes. That's parked with the other live checks (API key). The trigger-precision and resolve-rate evals are M7's.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved with the defaults: 10 escalations per account per day, and the "Taking a closer look…" status while Opus works | Owner's choice |
| 2026-10-10 | When Opus takes over, the call record restarts along with the step count | Opus gets a fresh start on all three triggers; otherwise one retry of a call Sonnet made twice would count as a loop straight away |
| 2026-10-10 | When both triggers apply to the same calls, `loop` is reported before `step_budget` | It's the more specific reason |
| 2026-10-10 | A limit refusal carries `limited: true` in its result, and a failed limit store gets the same marker | Neither is fixed by retrying or by Opus, so neither counts toward `repeated_tool_error` |
| 2026-10-10 | A failed escalation-budget store means no escalation (logged), so the turn goes to the support offer | Same rule as spec 014: a failed limit store refuses rather than lets through |
| 2026-10-10 | `PROMPT_VERSION` stays at 6 | Neither the system prompt nor the tool list changed; the support offer is a fixed reply, not part of the prompt |
