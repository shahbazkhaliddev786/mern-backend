# 014 — Per-user limits

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M6 — Hardening ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |
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

**Budgets** — `src/agent/limits.ts`, code constants like the step budget. The numbers are open question 1.

| Budget | Counts | Proposed limit | Over the limit |
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

- [ ] `src/agent/limits.ts`: budgets, lazy limiters, `setAgentLimiters()` for tests, the wait-message helper
- [ ] `agentTurnLimit` on the chat route; `writes` check on the upload route
- [ ] `withWriteLimit` around the write tools in `buildToolsForRequest`; support budget
- [ ] Audit log line
- [ ] Frontend: `limited` failure kind for chat and upload
- [ ] Tests (below)
- [ ] Update `security.md` §10 with the numbers, `phases.md` §0 and the spec index

## Acceptance criteria

- [ ] **Turn limits:**
  - [ ] The 21st chat request within 5 minutes gets 429 with `Retry-After` and the "please wait" message, and no stream starts.
  - [ ] Another user is unaffected.
  - [ ] Confirmation answers count too.
  - [ ] Covered by HTTP tests with an in-memory limiter.
- [ ] **Daily limit:** past 150 turns a day, the request is refused even when the 5-minute window is clear, and the message gives hours — test
- [ ] **Write limit:**
  - [ ] Over the limit, `add_to_cart` returns the "please wait" error and the cart service isn't called.
  - [ ] A confirmed `clear_cart` over the limit doesn't run.
  - [ ] A declined confirmation consumes nothing.
  - [ ] Read tools never consume.
  - [ ] Covered by tool and HTTP tests.
- [ ] **Support limit:** the 4th `submit_support_request` in an hour doesn't send, and its error points to `/contact` — tool test
- [ ] **Upload:** over the write limit, the upload gets 429 before the file is read — HTTP test
- [ ] **Limit store failure:** turns get 503 and write tools get an error; nothing runs — tests
- [ ] **Limiters:** created lazily and on in development — unit test
- [ ] **Audit log:** has the user id and budget, no message text — test
- [ ] **Frontend:** a 429 shows the server's message without **Try again**; an upload 429 shows in the chip — tests
- [ ] **Checks:** backend lint 0 errors, build, `npm test` with and without `MONGO_URL` (a MongoDB test for `RateLimiterMongo` itself); frontend tests, ESLint, Prettier, build

## Test plan

- **Unit:** `limits.ts` with `RateLimiterMemory`, covering the wait messages and both windows.
- **HTTP:** the existing `agent.routes.test.ts` setup with injected in-memory limiters.
- **MongoDB:** one test that the real `RateLimiterMongo` limiters reject after the limit (skips without `MONGO_URL`). This also covers the gap follow-ups §14 noted for the site's limiter.
- **Frontend:** `chat-panel.test.tsx` with the fake fetch.

## Open questions

1. **The numbers.** I propose 20 turns per 5 minutes and 150 per day, 30 writes per hour, and 3 support messages per hour.
   - **The daily cap is the cost ceiling.** At Sonnet 5.5's $2/$10 per million tokens, assuming about 25k input and 1k output tokens per turn across its model calls, a turn costs about $0.06, so 150 turns is about **$9 per account per day** at worst. The real per-turn figure comes from tracing (017); the cap can be tuned then.
   - **The support cap** matches the site's contact form, which is per-IP at 100 a minute: too loose for an inbox.
   - Change any of these if you have a different budget in mind.
2. **Should the daily turn cap exist at all?** It's the only one a real customer could hit in a long session.
   - **Recommended:** keep it at 150. It bounds a hijacked account's cost to a known number.
   - **Alternative:** drop it and rely on the 5-minute window (up to about 5,700 turns a day per account).

## Decision log

| Date | Decision | Why |
|---|---|---|
