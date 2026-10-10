# 016 — Sensitive-data guard and urgent alerts

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M6 — Hardening ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |
| **Repo** | `mern-backend`; one small change in `mern-frontend` (the browser-side check) |

## Goal

Card numbers and credentials never reach the model, its tools, or the customer's screen through the agent. If one gets past the first check, or a confirm-required action is about to run without a confirmation, it's blocked and someone is alerted at once.

## Context

- **Design:**
  - [`security.md`](../shopping-agent/security.md) §8: card data and secrets never reach the LLM. The threat table rates "card data or creds reaching the LLM" 🔴 Critical.
  - [`observability.md`](../shopping-agent/observability.md) §4, "Payment boundary guard": assert and alert if card-like or credential data appears in a prompt or tool argument.
  - Its "page immediately" alerts: a confirm-required write without a preceding confirmation, and a card or credential pattern in model input or output.
  - [`phases.md`](../shopping-agent/phases.md) M6: "detect card-like or credential patterns in model input/output and block + alert".
- **What exists:**
  - Nothing scans for sensitive data, and nothing sends alerts.
  - The logger keeps logs for 30 days in MongoDB, so no card number may ever reach a log line. Request bodies aren't logged.
  - The only outbound webhook is the support one (`SUPPORT_WEBHOOK_URL`, Make.com).
  - The confirmation gate (spec 008) is the only thing that makes a confirm-required tool wait for a "yes". There's no second check where tools run.
- **M6 split** (spec 014): 014 limits ✅, 015 Opus escalation ✅, **016 this spec**, 017 tracing.

## Scope

**In:**
- Pattern detection and redaction (`src/agent/guard.ts`).
- Checks on the customer's message (in the browser and on the server), tool arguments, tool results, and the model's text.
- A second confirmation check where tools run.
- Alerts: a log line, plus an optional webhook.

**Out:**
- **Store-side alerts** from the same observability table (two orders for one Stripe session, an order created other than by the webhook). That's order code, not the agent.
- **Tracing and the prompt-cache metric** (017).
- **Other personal data** (addresses, emails), which the agent handles legitimately.

## Design

**What's detected** — `src/agent/guard.ts`. These are pure functions that return the kinds found, never the matched text:
- **`card`:** 13–19 digits, optionally grouped by spaces or dashes, that pass the Luhn check. Order numbers (8 hex characters), prices and phone numbers don't pass.
- **`credential`:**
  - JWTs: `eyJ…` with three dot-separated parts.
  - Stripe secret and restricted keys: `sk_live_…`, `sk_test_…`, `rk_…`.
  - A password given as a value: "password is …", "password: …", "pwd=…". Asking *about* passwords ("how do I change my password?") isn't matched.
- **`redact(text)`** replaces each match with `[card number removed]` or `[credential removed]`.

**Where it's checked:**

| Point | What happens | Alert |
|---|---|---|
| **Customer message, in the browser** (Composer) | Checked before sending. Shows *"For your security, don't share card numbers or passwords here. Payment happens only on Stripe's checkout page."* The text stays in the box for the customer to edit, and nothing is sent | — |
| **Customer message, on the server** (a backstop, before the graph) | 400 with the same message. The message isn't sent to the model, isn't stored in the conversation, and isn't logged. `AGENT_SENSITIVE_INPUT { userId, kinds }` | — (blocked before the model; a customer mistake) |
| **Tool arguments** (tools node, before running) | The call isn't run and gets *"Not run: it contained sensitive data."* | `sensitive_in_tool_args` |
| **Tool results** (tools node, after running) | The result is redacted before the model sees it | `sensitive_in_tool_result` |
| **Model text** (streamed tokens) | A streaming redactor in the chat service holds back the last ~25 characters, so a number split across chunks is still caught, and redacts before sending. If the final message matches, it's replaced in the stored history by a fixed reply: *"Sorry, I can't share that here."* | `sensitive_in_model_output` |
| **Confirm-required write without a confirmation** (tools node) | The gate records approved tool-call ids in the state (`confirmedCalls`). The tools node refuses a confirm-required call whose id isn't there, with *"Not run: it wasn't confirmed."* | `unconfirmed_write` |

**Alerts** — `src/agent/alerts.ts`, `raiseAlert(kind, { userId, thread, tool?, toolCallId? })`. They carry ids only, never the data.
- **Always:** `logger.error('AGENT_ALERT', { kind, … })`, so a log-based alert can watch for it.
- **If `ALERT_WEBHOOK_URL` is set:** a fire-and-forget POST of `{ text: "Aljo agent alert: <kind> (user <id>, thread <hash>)" }`.
  - That shape works with Slack incoming webhooks and Make.com.
  - The POST times out after 3 seconds; a failure is logged and never breaks the turn.
- **New env var:** `ALERT_WEBHOOK_URL`, in `config.ts` and `.env.example`. It's optional and off until set.

## Tasks

- [x] `guard.ts`: detection, Luhn, `redact`, the streaming redactor
- [x] `alerts.ts` + `ALERT_WEBHOOK_URL`
- [x] Server check on the customer's message
- [x] Tools node: argument check, result redaction, `confirmedCalls` check
- [x] Model text: streaming redaction in the chat service; replace a matching final message
- [x] Frontend: Composer check
- [x] Tests (below)
- [x] Update `observability.md` (the guard and alerts as built), `phases.md` §0 and the spec index

## Acceptance criteria

- [x] **Detection:**
  - [x] Luhn-valid cards match in every format, including Stripe's test card 4242 4242 4242 4242.
  - [x] Order numbers, prices, phone numbers and SKUs don't match.
  - [x] Every live knowledge chunk and the tool tests' product fixtures produce no matches.
  - [x] Credential phrases match; questions about passwords don't.
  - [x] Covered by unit tests.
- [x] **Streaming redactor:** catches a card number split across chunks, and passes ordinary text through unchanged and in order — unit test
- [x] **Customer message on the server:**
  - [x] A card number gets a 400, no model call, and nothing stored in the conversation.
  - [x] The log line has kinds only, no digits.
  - [x] Covered by an HTTP test.
- [x] **Tool arguments:** sensitive arguments aren't run, and an alert fires — graph test
- [x] **Tool results:** a sensitive result is redacted before the model sees it, and an alert fires — graph test
- [x] **Model text:**
  - [x] Streamed tokens are redacted.
  - [x] A matching final message is replaced in the stored history.
  - [x] An alert fires.
  - [x] Covered by graph and HTTP tests.
- [x] **Unconfirmed write:**
  - [x] A confirm-required call that reaches the tools node without a recorded approval doesn't run, and an alert fires. The bypass is simulated by starting a run with a `Command` that jumps straight to the tools node.
  - [x] Normal confirm and decline flows are unaffected.
  - [x] Covered by graph tests.
- [x] **Alerts:**
  - [x] The webhook gets a POST with ids only.
  - [x] A webhook failure or timeout doesn't break the turn.
  - [x] Nothing is posted when the URL isn't set.
  - [x] This is the "staged test" in M6's exit criteria.
- [x] **Frontend:** the Composer refuses a card number in the browser and keeps the text; ordinary messages with numbers ("2 of the blue ones under $50", order #1A2B3C4D) still send — tests
- [x] **Checks:** backend lint 0 errors, build, `npm test` 211 + 30 skipped / 241 with `MONGO_URL` and `ATLAS_URL`; frontend 69 tests, ESLint 0 errors, Prettier, build

## Test plan

- **Unit:** `guard.ts` and `alerts.ts`, with a local HTTP server standing in for the webhook.
- **Graph:** scripted models and recording tools, as in specs 008 and 015.
- **HTTP:** the `agent.routes.test.ts` setup.
- **Frontend:** `chat-panel.test.tsx`.

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**2026-10-10** — backend in this repo; frontend `mern-frontend` `65aa829`.
- **Files:**
  - backend: `src/agent/guard.ts` (detection, Luhn, `redact`, `StreamRedactor`) and `src/agent/alerts.ts`
  - the checks in `graph.ts` (tools node, agent node, `confirmedCalls` from the gate), `chat.service.ts` (streamed text) and `agent.controller.ts` (the customer's message)
  - `ALERT_WEBHOOK_URL` in `config.ts` and `.env.example`
  - frontend: `services/sensitive.ts` and the Composer check
- **New tests:**
  - backend: `guard.test.ts` (10), `alerts.test.ts` (4: the staged webhook test, including failure and a 3-second timeout), 5 graph tests, 3 HTTP tests
  - frontend: 2 (67 → 69)
- **No false positives** on any live knowledge chunk, product ids, order numbers, prices or phone numbers.
- **What the customer sees** when the model's reply holds a card number: *"Your card [card number removed] is on file."* The history stores *"Sorry, I can't share that here."* instead.
- **Not yet set:** `ALERT_WEBHOOK_URL` in production. Until it is, alerts are the `AGENT_ALERT` log line only.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved with the defaults: alerts go to the `AGENT_ALERT` log line plus an optional `ALERT_WEBHOOK_URL`; credentials are JWTs, Stripe secret keys and password-as-value phrases; the customer's message is checked in the browser too | Owner's choice |
| 2026-10-10 | Card numbers must start with 2–6, besides passing the Luhn check | Real card numbers do. It also rules out runs of zeros inside product ids (e.g. `64b0000000000000000000c1`), which pass Luhn |
| 2026-10-10 | A password-as-value match needs a digit in the value | The store's password rules require one; without it "the password is required" would match |
| 2026-10-10 | When the model's reply holds a card number, the customer sees it redacted as it streamed; the fixed reply goes into the history only (an id prefix keeps it out of the stream) | The reply has already streamed by the time it's checked; streaming the fixed reply too showed both, glued together |
| 2026-10-10 | Refused calls (sensitive arguments, no approval) don't count as tool failures for escalation | Neither is fixed by retrying or by Opus (the same rule as spec 015's limit refusals) |
| 2026-10-10 | The streamed text is held back by up to 40 characters | Long enough for a grouped 19-digit card number split across chunks; released before any other event, so text and status chips stay in order |
| 2026-10-10 | The gate bypass in the test is simulated with a `Command` that jumps to the tools node, not with `updateState` | `updateState` can't place the graph after the gate, which has no static edges |
