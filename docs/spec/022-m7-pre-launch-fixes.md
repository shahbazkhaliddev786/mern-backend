# 022 — Pre-launch fixes from the code review

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M7 — Evals & launch gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-27 |
| **Updated** | 2026-10-27 |
| **Closed by** | backend `303866d`; frontend `6b382d9` |
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
- [x] 1 cart hash with prices
- [x] 2 gate rule for mixed batches
- [x] 4 name check and cleaning
- [x] 5 claim release
- [x] 6 history repair
- [x] 8 refund of the other budgets
- [x] 9 turn end in try/catch
- [x] 10 vote keeps its review
- [x] 13 probe removed
- [x] each with a test that fails before the fix

**Frontend:**
- [x] 3 link check
- [x] 7 retry and reopen rules
- [x] 11 single-flight refresh
- [x] 12 chat state above the panel
- [x] each with a test that fails before the fix

**Docs:**
- [x] `follow-ups.md` (the 4 deferred items)
- [x] the spec index and `phases.md` (launch → 023)

## Acceptance criteria

Each item has a test that reproduces the defect first and then passes.

- [x] **1:** the same cart at a new price creates a new Stripe session; the same cart and price still reuses the link — MongoDB test.
- [x] **2:** `add_to_cart` and `place_order` in one batch run nothing and pause nothing; each gets the "on its own" answer — graph test. The safety gate still passes 17 / 1 n/a.
- [x] **3:** `/\evil.com`, `//evil.com` and `/%5Cevil.com` render as text; `/products/abc` is still a link — component test.
- [x] **4:** a name with a card number gets a 400; a name with newlines is stored and sent as one clean line — HTTP test.
- [x] **5:** a resume whose gate step fails can be answered again; a resume that completed still gets "already confirmed" — HTTP test with MongoDB.
- [x] **6:** after a run aborted mid-tool, the next message gets an answer, and the model sees a result for every earlier tool call — graph and HTTP test.
- [x] **7:** each of (a)–(d) — chat-panel tests.
- [x] **8:** a burst-refused request leaves the daily points unchanged; a support-refused request leaves the write points unchanged — limits test.
- [x] **9:** a `getState` failure at the end of a turn still sends `done` and ends the response — test.
- [x] **10:** the same rating keeps `review`; a new rating clears it — MongoDB test.
- [x] **11:** two simultaneous 401s make one refresh call, and both requests succeed — service test.
- [x] **12:** closing and reopening the panel mid-reply shows the full reply — chat-panel test.
- [x] **13:** the route and setting are gone; the test that covered them is removed with them.
- [x] **Checks:**
  - **Backend:** lint 0 errors, build, `npm test` with and without the databases, CI green.
  - **Frontend:** lint, Prettier, typecheck, tests, build.

## Test plan

- Unit, graph, HTTP and MongoDB tests per the criteria above.
- Each fix is proven by a test written to fail before the change.
- No real-model run is needed; the behaviour is in our code, not the model.

## Open questions

_None — resolved 2026-10-27, see the decision log._

## Results

**2026-10-27.** Every fix was proven the same way: a test reproduced the defect first, then passed once the fix was in.

**Backend (`303866d`):**

| # | Fix | Test (failed before the fix) |
|---|---|---|
| 1 | Prices are part of the cart hash | `checkout-reuse.mongo.test.ts`: a price change makes a new Stripe session |
| 2 | A mixed batch with a confirm-required call runs nothing | `graph.test.ts`: `add_to_cart` and `clear_cart` together both get "Not run: do the other steps first…" |
| 4 | File names are checked (400 if sensitive) and cleaned to one line | `agent.routes.test.ts`: a card number in a name, and a name with newlines and a fake note |
| 5 | The claim is released when a resumed run fails before the gate is saved | `agent.routes.test.ts`: a failed resume can be answered again, a completed one can't; plus `releaseConfirmation` against MongoDB |
| 6 | Unanswered tool calls get a result before the next message | `agent.routes.test.ts`: without the fix, the model was sent a tool call with no result (`[]` vs `['call_1']`), the request the API rejects |
| 8 | A refused request gives back the points it took | `limits.test.ts`: burst refusals don't touch the daily points; a support refusal costs no write |
| 9 | The end of a turn survives a failed state read | `agent.routes.test.ts`: before the fix the connection closed with no `done` ("other side closed") |
| 10 | The same vote keeps its review; a changed vote reopens it | `evals/online/online.mongo.test.ts` |
| 13 | The streaming probe is removed: the controller, `STREAM_PROBE_ENABLED` and its tests | `agent.routes.test.ts`: the route answers 404 |

- **Checks:** lint 0 errors (warnings unchanged at 106); build clean; `npm test` 332 with both databases (323 before) and 256 + 76 skipped without them; safety gate 17 pass, 1 n/a.

**Frontend (`6b382d9`):**

| # | Fix | Test (failed before the fix) |
|---|---|---|
| 3 | Store links must be same-origin paths, with no backslash and no `%5C` | `[a](/\evil.example)`, `//evil.example`, `/%5Cevil.example` and `/%5cevil.example` render as text |
| 7 | (a) "Try again" is disabled while busy; (b) not offered once an action ran; (c) the card stays answered after Stop or a drop mid-answer; (d) no dead "Try again" on a confirmation answer | six chat-panel tests |
| 11 | One shared token refresh | two requests hitting 401 together cause one refresh, and both succeed |
| 12 | The conversation lives in `ChatLauncher` | close the panel mid-reply, reopen: the full reply is there, and nothing was aborted |

- **Checks:** ESLint 0 errors (the 3 warnings are in unrelated files); Prettier, stylelint, typecheck and build pass; 83 tests (74 before).

**Notes:**
- **Item 3's real-world risk was lower than the review said.** react-markdown already turns `/\evil.example` into `/%5Cevil.example`, which is an ordinary path on the store's own site. The stricter check is defence in depth.
- **Item 6's test first failed on how the stream splits text,** not on the defect. The assertion was fixed to check the model's input, and it was re-proven to fail without the fix.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-27 | Approved with the defaults: a mixed batch runs nothing; a sensitive file name is refused; the probe is removed; these fixes are 022 and launch is 023 | Owner's choice |
| 2026-10-27 | A kept review also keeps its expiry | Otherwise a reviewed record would wait another 90 days |
| 2026-10-27 | Control characters are matched with `\p{Cc}` | The literal ranges fail ESLint's `no-control-regex`; the Unicode class means the same thing |
