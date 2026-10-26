# 022 — Pre-launch fixes from the code review

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M7 — Evals & launch gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-27 |
| **Updated** | 2026-10-27 |
| **Closed by** | — |
| **Repo** | `mern-backend` and `mern-frontend` |

## Goal

Fix every defect the review of the two agent pull requests found that matters before the assistant goes live:
- no customer can be charged a price they didn't confirm
- no confirmation applies to a different cart than the one shown
- no link in a reply can leave the store
- no conversation can get stuck for good
- "Try again" never loses or repeats an action
- refused requests don't use up a customer's other limits

None of these affect the store while the agent is off, but all must be fixed before `AGENT_ENABLED` is turned on.

## Context

- **The review:** an engineering review of `shahbazkhaliddev786/mern-backend#1` and `shahbazkhaliddev786/mern-frontend#1` (2026-10-27).
  - It found 20 issues, listed in the review summary in chat.
  - This spec takes the 8 "before launch" items and the 5 "should fix" items. The 4 "nice to have" items go to `follow-ups.md`.
  - The two most serious were checked by hand against the code: the stale-price reuse (item 1) and the stuck confirmation claim (item 5).
- **Where each defect came from:**
  - the checkout reuse: spec 010
  - the confirmation gate and its claim: specs 002, 008 and 009
  - attachments: spec 012
  - limits: spec 014
  - the chat panel: specs 007, 009 and 012
  - feedback and turn ends: spec 021
- **The M7 split moves:**
  - this spec takes number 022
  - launch becomes **023**
  - numbers are never reused, and nothing had been written for 022
- **What isn't affected:** the store's own `/checkout` page uses `createCheckoutSession` directly, not the agent's reuse path.

## Scope

**In:** items 1–13 below.

**Out:**
- **The "nice to have" items,** recorded in `follow-ups.md`:
  - the duplicate reads in checkout
  - object URLs never released
  - the login and refresh code copied three times in the frontend
  - a stray "Stopped" label after switching user accounts
- **New features or prompt changes.**

## Design

### Money and safety

**1. Checkout reuse must not charge an old price** — `src/services/order.service.ts`
- `computeCartHash` also covers each line's **unit price** (`productId:quantity:price`).
- Any price change means a new Stripe session rather than the old link.
- Reuse still works for the same cart, prices and address.

**2. A confirmation must cover exactly what runs** — `src/agent/graph.ts`, the gate
- **The rule:** when a batch has a confirm-required call **and any other call**, nothing in it runs. Each call is answered "Not run: ask for this on its own, after the other steps" (open question 1). The model then runs the other steps first and asks for the confirmation alone, so the summary is built from the cart as it really is.
- **This extends an existing rule:** the gate already refuses more than one confirm-required call in a batch.

**3. Reply links can't leave the store** — frontend, `AssistantMessage.tsx`
- `isStoreLink` accepts only `href`s that parse, against the page's origin, to the **same origin**, and that start with `/` and contain no backslash.
- So `/\evil.com`, `//evil.com` and the encoded forms of those are shown as plain text, never as links.

**4. Attachment names can't carry data or instructions to the model**
- **On upload** (`uploadAvatarHandler`):
  - a name containing a card number or credential (`findSensitive`) is refused with 400 and the spec 016 message (open question 2)
  - otherwise the name is cleaned before it's stored: control characters and newlines are removed, spaces are collapsed, and it's cut to 80 characters
- **In the note to the model,** the same cleaning is applied again, as a second line of defence for uploads made before this change.

### Conversations getting stuck

**5. A failed Confirm can't freeze the conversation** — `chat.service.ts`, `checkpointer.ts`
- If a resumed run ends with an error or an abort, the service checks whether the same interrupt is still pending, meaning the gate step never completed.
- If it is, it releases the claim (`releaseConfirmation(interruptId)`, which deletes the `confirm_claims` row), so the customer can answer again.
- A claim whose step did complete is kept, so the same action can never run twice.

**6. Leaving mid-action can't break the history** — `chat.service.ts`
- Before a new message starts a turn, the service checks the checkpoint.
- If the last assistant message has tool calls with no results, and no confirmation is pending, it adds a result for each: "Not run: the previous turn was interrupted." It uses `graph.updateState`, appending, never editing (the history stays append-only).
- The API then accepts the next turn.

**7. "Try again" never loses or repeats anything** — frontend, `useAgentChat.ts`
- **(a)** "Try again" is disabled while a reply streams or a confirmation waits, and the failed turn is removed only once the resend actually starts.
- **(b)** If the stream drops **after any tool ran** (a `tool_end` was seen), the error isn't retryable. It reads: "The connection dropped after I'd started. Check your cart or orders before asking again."
- **(c)** For a confirmation answer, the card reopens only if the request never reached the server: sign-in, limit or unavailable answers, or a network error before any response. After Stop or a mid-stream drop, the card stays answered, with a note to ask the assistant what happened.
- **(d)** An `error` event on a confirmation answer is never retryable, so there's no dead "Try again" button.

**8. A refused request doesn't spend the other limits** — `src/agent/limits.ts`
- When one budget refuses, `consumeBudgets` gives back (`reward`) the points it just took from the others.
- So retrying past the 5-minute limit no longer drains the daily allowance, and a refused support message no longer costs a write.
- `AgentLimiters` gains `reward`, and the in-memory test limiters support it.

### Smaller fixes

**9. A turn always ends cleanly** — `chat.service.ts`
- The `getState` calls at the end of a turn (for the reply id) and in the span's `finally` are wrapped in try/catch.
- On failure, `done` is still sent (without `replyId`), the span still ends, and the original error isn't hidden.

**10. A repeat vote keeps the review decision** — `online-evals.ts`
- `saveFeedback` keeps `review` when the rating is unchanged.
- A changed rating is new information, so it clears `review` and the record goes back to the queue.

**11. One login refresh at a time** — frontend, `agent-chat.service.ts`
- `refreshTokens` is single-flight: requests that hit a 401 at the same moment share one refresh, so the second no longer signs the customer out.

**12. Closing the panel doesn't cancel the reply** — frontend
- `useAgentChat` moves up from `ChatPanel` to `ChatLauncher`, so the conversation and its stream live while the panel is closed.
- Reopening shows the finished reply.
- Signing out, or switching user, still aborts.

**13. The temporary streaming test route is removed** — `stream-probe.controller.ts`, `agent.routes.ts`, `STREAM_PROBE_ENABLED`
- Spec 004 marked it TEMPORARY, to be removed when that spec closed (open question 3).

## Tasks

**Backend:**
- [ ] 1 cart hash with prices
- [ ] 2 gate rule for mixed batches
- [ ] 4 name check and cleaning
- [ ] 5 claim release
- [ ] 6 history repair
- [ ] 8 refund of the other budgets
- [ ] 9 turn end in try/catch
- [ ] 10 vote keeps its review
- [ ] 13 probe removed
- [ ] each with a test that fails before the fix

**Frontend:**
- [ ] 3 link check
- [ ] 7 retry and reopen rules
- [ ] 11 single-flight refresh
- [ ] 12 chat state above the panel
- [ ] each with a test that fails before the fix

**Docs:**
- [ ] `follow-ups.md` (the 4 deferred items)
- [ ] the spec index and `phases.md` (launch → 023)

## Acceptance criteria

Each item has a test that reproduces the defect first and then passes.

- [ ] **1:** the same cart at a new price creates a new Stripe session; the same cart and price still reuses the link — MongoDB test.
- [ ] **2:** `add_to_cart` and `place_order` in one batch run nothing and pause nothing; each gets the "on its own" answer — graph test. The safety gate still passes 17 / 1 n/a.
- [ ] **3:** `/\evil.com`, `//evil.com` and `/%5Cevil.com` render as text; `/products/abc` is still a link — component test.
- [ ] **4:** a name with a card number gets a 400; a name with newlines is stored and sent as one clean line — HTTP test.
- [ ] **5:** a resume whose gate step fails can be answered again; a resume that completed still gets "already confirmed" — HTTP test with MongoDB.
- [ ] **6:** after a run aborted mid-tool, the next message gets an answer, and the model sees a result for every earlier tool call — graph and HTTP test.
- [ ] **7:** each of (a)–(d) — chat-panel tests.
- [ ] **8:** a burst-refused request leaves the daily points unchanged; a support-refused request leaves the write points unchanged — limits test.
- [ ] **9:** a `getState` failure at the end of a turn still sends `done` and ends the response — test.
- [ ] **10:** the same rating keeps `review`; a new rating clears it — MongoDB test.
- [ ] **11:** two simultaneous 401s make one refresh call, and both requests succeed — service test.
- [ ] **12:** closing and reopening the panel mid-reply shows the full reply — chat-panel test.
- [ ] **13:** the route and setting are gone; the test that covered them is removed with them.
- [ ] **Checks:**
  - **Backend:** lint 0 errors, build, `npm test` with and without the databases, CI green.
  - **Frontend:** lint, Prettier, typecheck, tests, build.

## Test plan

- Unit, graph, HTTP and MongoDB tests per the criteria above.
- Each fix is proven by a test written to fail before the change.
- No real-model run is needed; the behaviour is in our code, not the model.

## Open questions

1. **Mixed batches with a confirm-required call** (item 2).
   - **Recommended:** run nothing and tell the model to do the other steps first, then ask on its own. That's simple, matches the existing one-confirmation-at-a-time rule, and the summary is always built from the real cart.
   - **Alternative:** run the other calls first, then build the summary and pause. Customers would see fewer round trips, but the gate gets more complex.
2. **A card number or password in an attachment's file name** (item 4).
   - **Recommended:** refuse the upload with the spec 016 message, so nothing sensitive is stored.
   - **Alternative:** silently rename the file to "image".
3. **The temporary streaming test route** (item 13).
   - **Recommended:** remove it. It did its job in spec 004, and leaving it is an open door if the setting is ever switched on.
4. **Numbering.**
   - **Recommended:** these fixes are 022, and launch becomes 023, so the launch spec can require them.

## Decision log

| Date | Decision | Why |
|---|---|---|
