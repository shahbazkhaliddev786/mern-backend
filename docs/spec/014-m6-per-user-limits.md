# 014 — Per-user limits

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M6 — Hardening ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | `b145da2` + `mern-frontend` `e1383c4` |
| **Repo** | `mern-backend` (limits); one small change in `mern-frontend` (the "slow down" message) |

## Goal

One account can't run up the model bill, flood the store with changes, or spam the support inbox through the agent. Each customer has their own budgets for chat turns, writes and support messages. Going over gets a clear "please wait N minutes", and nothing runs.

## Context

- **Design:**
  - [`security.md`](../shopping-agent/security.md) §10: per-user limits on LLM calls and writes, keyed on `ctx.userId`, on in every environment.
  - [`reconciliation.md`](../shopping-agent/reconciliation.md) Gap 17: same `rate-limiter-flexible` + Mongo store as the site, created lazily (follow-ups §14).
- **What exists:**
  - the site's per-IP limiter, `getRateLimiter()` in `src/config/rate.limiter.ts`: lazy, 100 requests a minute, used on sign-in, credential and support routes, off in development
  - the agent's step budget, 8 tool calls per turn (spec 006)
  - the duplicate-checkout guard (spec 010)
  - Nothing limits how many turns or writes one account makes.
- **M6 split** (one spec at a time, in this order):

| Spec | Delivers | Why this order |
|---|---|---|
| **014** | Per-user limits: turns, writes, support messages | Caps cost and abuse before anything else ships to production. 015 reuses the limiter |
| 015 | Opus escalation for stuck turns, with its own budget | Changes agent behaviour; needs the limiter from 014 |
| 016 | Payment-boundary guard and the "page immediately" alerts | Safety checks on model input and output |
| 017 | Tracing (OpenTelemetry → LangSmith + OTLP), trace schema, prompt-cache hit rate | Largest piece; needs a LangSmith key and an OTLP endpoint |

## Scope

**In:**
- An agent limiter module with four budgets (below).
- **The turn budget:** checked on `POST /agent/chat`, for both new messages and confirmation answers.
- **The write budget:** checked when a write tool runs, and on the avatar upload endpoint.
- **The support budget:** checked when `submit_support_request` runs.
- **Responses:** a 429 with a "please wait" message, plus a tool error the model relays.
- An audit log line when a limit is hit.
- Frontend: show the server's message for a 429.

**Out:**
- The escalation budget (015).
- The site's per-IP limiter and its deploy check (follow-ups §14).
- Admin exemptions or a UI to change limits.

## Design

**Budgets** — `src/agent/limits.ts`, code constants like the step budget.

| Budget | Counts | Limit | Over the limit |
|---|---|---|---|
| `turns` (burst) | each `POST /agent/chat` | 20 per 5 minutes | `429` before the stream starts |
| `turns` (daily) | the same requests | 150 per 24 hours | `429` before the stream starts |
| `writes` | each write tool that actually runs, and each avatar upload | 30 per hour | The tool returns an error the model relays; the upload gets a `429` |
| `support` | each `submit_support_request` that runs | 3 per hour | The tool returns an error that points to `/contact` |

- **Keyed on the user's id** from the verified session, never on IP. A hijacked session is capped per account, and shoppers who share an IP don't share a budget.
- **Confirm-required writes count only when they run,** i.e. after the customer confirms. Declining costs nothing, and reads never count against `writes`.
- **Limiter:** `RateLimiterMongo` on mongoose's connection, one key prefix per budget (`agent_turns_5m`, `agent_turns_1d`, `agent_writes`, `agent_support`).
  - It's created on first use, so the Vercel entry point gets it too.
  - It's on in every environment, development included.
  - Tests inject `RateLimiterMemory` through `setAgentLimiters()`.
- **Both turn windows are checked together.** If one rejects, the request is refused, and the answer gives the longer wait.
- **If the limit store fails** (e.g. MongoDB down), the request is refused as unavailable (503), not let through. The chat can't run without MongoDB anyway, since the checkpointer is there. The error is logged.

**Turn check** — `agentTurnLimit` middleware on the chat route, after `auth`, before the body is parsed into a stream:
- It answers `429 { status: 'error', message: "You've sent a lot of messages in a short time. Please wait about N minutes and try again." }` with a `Retry-After` header.
- `N` is rounded up from the limiter's wait. A daily-limit refusal says "about N hours".

**Write and support checks** — `withWriteLimit(tool, ctx)` wraps each write tool in `buildToolsForRequest`, keeping its name, description, schema and metadata:
- **Before running,** it consumes one `writes` point, plus one `support` point for `submit_support_request`.
- **Over the limit,** it returns `toolError("You've made a lot of changes in a short time. Please wait about N minutes and try again.")` without running the tool. The support version adds "…or use the Contact page (/contact)".
- **Where the check sits:** the wrapper runs inside the tools node, which comes after the confirmation gate. So a confirmed action that's over the limit still doesn't run, and the customer sees why.
- **Upload endpoint:** `POST /agent/uploads/avatar` checks `writes` too, after `auth` and before multer reads the file.

**Audit log:** `AGENT_RATE_LIMITED { userId, budget, msBeforeNext }`, with no message content.

**Frontend** (`services/agent-chat.service.ts`):
- A `429` becomes `ChatFailure('limited', <server message>)`.
- It's shown in the chat without **Try again**: retrying straight away would be refused again.
- The same mapping applies to `uploadAvatar`; the chip shows the message.

## Tasks

- [x] `src/agent/limits.ts`: budgets, lazy limiters, `setAgentLimiters()` for tests, the wait-message helper
- [x] `agentTurnLimit` on the chat route; `writes` check on the upload route
- [x] `withWriteLimit` around the write tools in `buildToolsForRequest`; support budget
- [x] Audit log line
- [x] Frontend: `limited` failure kind for chat and upload
- [x] Tests (below)
- [x] Update `security.md` §10 with the numbers, `phases.md` §0 and the spec index

## Acceptance criteria

- [x] **Turn limits:**
  - [x] The 21st chat request within 5 minutes gets 429 with `Retry-After` and the "please wait" message, and no stream starts.
  - [x] Another user is unaffected.
  - [x] Confirmation answers count too.
  - [x] Covered by HTTP tests with an in-memory limiter.
- [x] **Daily limit:** past 150 turns a day, the request is refused even when the 5-minute window is clear, and the message gives hours — test
- [x] **Write limit:**
  - [x] Over the limit, `add_to_cart` returns the "please wait" error and the cart service isn't called.
  - [x] A confirmed `clear_cart` over the limit doesn't run.
  - [x] A declined confirmation consumes nothing.
  - [x] Read tools never consume.
  - [x] Covered by tool and HTTP tests.
- [x] **Support limit:** the 4th `submit_support_request` in an hour doesn't send, and its error points to `/contact` — tool test
- [x] **Upload:** over the write limit, the upload gets 429 before the file is read — HTTP test
- [x] **Limit store failure:** turns get 503 and write tools get an error; nothing runs — tests
- [x] **Limiters:** created lazily and on in development — unit test
- [x] **Audit log:** has the user id and budget, no message text — test
- [x] **Frontend:** a 429 shows the server's message without **Try again**; an upload 429 shows in the chip — tests
- [x] **Checks:** backend lint 0 errors, build, `npm test` 177 + 30 skipped / 207 with `MONGO_URL` and `ATLAS_URL` (a MongoDB test for `RateLimiterMongo` itself); frontend 67 tests, ESLint 0 errors, Prettier, build

## Test plan

- **Unit:** `limits.ts` with `RateLimiterMemory`, covering the wait messages and both windows.
- **HTTP:** the existing `agent.routes.test.ts` setup with injected in-memory limiters.
- **MongoDB:** one test that the real `RateLimiterMongo` limiters reject after the limit (skips without `MONGO_URL`).
- **Frontend:** `chat-panel.test.tsx` with the fake fetch.

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**2026-10-10** — backend in this repo; frontend `mern-frontend` `e1383c4`.
- **Files:**
  - `src/agent/limits.ts` (budgets, lazy limiters, `consumeBudgets`, `waitPhrase`)
  - `src/agent/tools/write-limit.ts` (`withWriteLimit`)
  - the `agentTurnLimit` and `agentUploadLimit` checks in `agent.controller.ts`, wired in `agent.routes.ts`
  - frontend: the `limited` failure kind
- **New tests:**
  - backend: `limits.test.ts` (5), `limits.mongo.test.ts` (2), 6 tool tests, 7 HTTP tests, 2 graph tests (a confirmed action over the limit doesn't run; a declined one costs nothing)
  - frontend: 3 (64 → 67)
- **Example messages:**
  - *"You've sent a lot of messages in a short time. Please wait about 3 minutes and try again."*
  - *"…Please wait about 24 hours…"* (daily cap)
  - *"You've sent several messages to support recently. Please wait about 1 hour, or use the Contact page (/contact)."*
- **Still untested:** the site's own per-IP limiter has no rejection test yet (follow-ups §14). These tests cover the agent's limiters only.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Limits: 20 turns per 5 minutes and 150 per day, 30 writes per hour, 3 support messages per hour | Owner agreed. The daily cap is the cost ceiling (about $9 per account per day at worst, by the spec's estimate) and is retuned with real per-turn costs from tracing (017) |
| 2026-10-10 | Keep the daily turn cap | Bounds a hijacked account's cost to a known number; without it the 5-minute window allows about 5,700 turns a day |
| 2026-10-10 | The turn check runs after body validation | A malformed request costs nothing and gets a 400; it shouldn't use up a turn |
| 2026-10-10 | A refused request still uses a point in every budget it checks (e.g. a message refused by the 5-minute window still counts toward the daily cap) | Every window counts every attempt, which is how the limiter works; hammering a closed window shouldn't be free |
| 2026-10-10 | The write-limit wrapper lives in `tools/write-limit.ts` | Keeps it testable without loading every tool (and the services' Cloudinary config) |
| 2026-10-10 | A confirmation answer refused by the turn limit puts the card back to pending | Nothing ran; the customer can confirm once the wait is over (the same rule as spec 009's network failures) |
