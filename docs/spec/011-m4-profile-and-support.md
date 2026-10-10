# 011 — update_profile and submit_support_request

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M4 — Write tools + confirmation gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |
| **Repo** | `mern-backend`; one small change in `mern-frontend` (header name) |

## Goal

The agent can change the customer's display name and send a message to human support, each after the customer confirms. The support message always carries the session's name and email.

## Context

- **Tools** ([`architecture.md`](../shopping-agent/architecture.md) §4): `update_profile(name)` (account-changing) and `submit_support_request(subject, message)` (external; the human-escalation path). Both need confirmation ([`security.md`](../shopping-agent/security.md) §6).
- **Rules** (security.md §7, [`reconciliation.md`](../shopping-agent/reconciliation.md) Gaps 9–10):
  - `update_profile` takes the **name only**. Email and password changes stay in the UI.
  - A support request's sender **name and email come from the session**, never from the model.
- **Store services used:**
  - `updateUserProfile(userId, name?)` in `src/services/auth.service.ts`.
  - `submitSupportRequest({ …, source: 'agent' })` in `src/services/support.service.ts`, which throws `SupportDeliveryError` with 503 when not configured and 502 when delivery fails.
  - `supportMessageSchema` in `src/validations/support.schema.ts`.

## Scope

**In:**
- The two tools and their confirmation summaries.
- Labels, and a prompt update with `PROMPT_VERSION` 4.
- Frontend: the header shows the new name after the agent changes it.

**Out:**
- Avatar (012) and `cancel_order` (013).
- Email and password changes, which stay in the UI by design.

## Design

| Tool | Arguments | Calls | Returns | Summary |
|---|---|---|---|---|
| `update_profile` | `name`, trimmed, 2–50 characters (the sign-up rule) | `updateUserProfile(ctx.userId, name)` | `{ name }` | *Change your name from "Jane" to "Jane Doe"?* |
| `submit_support_request` | `subject` 3–100, `message` 10–500 (`supportMessageSchema`) | `submitSupportRequest` with the **session user's** name and email, `userId: ctx.userId`, `source: 'agent'` | `{ sent: true }` | *Send this to Aljo Store support as Jane Doe (jane@example.com)? Subject: "…" — "…"* (the message is shortened to about 120 characters in the summary) |

- Both are confirm-required.
- A `SupportDeliveryError` becomes a plain `{ error }` with its message, so the agent can point to `/contact` instead.
- Audit: the existing `AGENT_CONFIRMATION` and `AGENT_WRITE` logs (ids only). No name, email or message text is logged.
- **Frontend:** after a successful `update_profile`, the chat refetches the profile and updates the auth state's name, the same way the Edit Profile form does.

## Tasks

- [x] `account-writes.ts` (both tools, summaries); registration; labels
- [x] Prompt + `PROMPT_VERSION` 4
- [x] Frontend header name update
- [x] Tests
- [x] Update `phases.md` §0 and the spec index

## Acceptance criteria

- [x] Both tools are confirm-required; summaries are correct and only read — tool tests
- [x] `update_profile` sends `ctx.userId` and the trimmed name, rejects names outside 2–50, and its schema has only `name` — tool tests
- [x] `submit_support_request` sends the session's name and email with `source: 'agent'`; its schema has only `subject` and `message`, and sender fields added by the model are ignored; bounds enforced; delivery failures become plain errors — tool tests
- [x] A confirm-required `update_profile` pauses and runs once on confirm over HTTP — HTTP test
- [x] Frontend: after `tool_end` for `update_profile`, the auth state's name updates from the profile — test
- [x] Backend lint 0 errors, build, `npm test` 130 + 14 skipped / 144 with `MONGO_URL`; frontend 55 tests, ESLint 0 errors, Prettier, build

## Test plan

- **Backend:** mocked services in `tools.test.ts`; one HTTP test in `agent.routes.test.ts`.
- **Frontend:** a test in `chat-panel.test.tsx` with a mocked profile fetch.

## Open questions

_None — approved with the plan._

## Results

**2026-10-10** — backend in this repo; frontend `mern-frontend` `b6f62dd`.
- New tests: 8 tool tests (3 `update_profile`, 5 `submit_support_request`), 1 HTTP confirm test, 1 frontend test.
- Example confirmations:
  - *Change your name from "Jane" to "Jane Doe"?*
  - *Send this to Aljo Store support as Jane Doe (jane@example.com)? Subject: "Late order" — "My order hasn't arrived after two weeks."*
- Not yet seen: delivery to the real Make.com webhook. It needs `SUPPORT_WEBHOOK_URL` set by the owner ([`reconciliation.md`](../shopping-agent/reconciliation.md) Gap 9). Until then the tool reports "Support requests are temporarily unavailable…".

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved with the plan | — |
| 2026-10-10 | Sender fields the model adds to `submit_support_request` are dropped by the schema, not rejected | The schema simply has no such fields, so identity always comes from the session and a stray field can't fail the request |
| 2026-10-10 | The prompt now points cancellation requests to `/dashboard` or an offer to contact support | `cancel_order` comes in 013; support is the working path until then |
