# 021 — Online evals and feedback

| | |
|---|---|
| **Status** | Done (the first real judged batch is parked until the keys and secrets are set) |
| **Milestone** | M7 — Evals & launch gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-26 |
| **Updated** | 2026-10-26 |
| **Closed by** | backend `fba693c` + `826f763`; frontend `ce07a15` |
| **Repo** | `mern-backend` and `mern-frontend` |

## Goal

Catch quality drift in production and feed it back into the goldens. When this spec is done:

1. Customers can give **thumbs up or down** on the assistant's replies, with an optional reason.
2. **Claude Haiku 5.5 judges** a small sample of live turns every day.
3. **Flagged turns** (a thumbs-down or a low score) are reviewed. The problems they show become new goldens, so CI guards against them from then on.

## Context

- **Design:**
  - [`evals.md`](../shopping-agent/evals.md) §12: online evals and the feedback loop. §10: Haiku 5.5 for cheap online sampling.
  - [`observability.md`](../shopping-agent/observability.md) Layer 6 (the sampled judge, thumbs, a task-success proxy, traces into goldens), and `outcome.user_feedback` in the minimum trace schema.
  - [`phases.md`](../shopping-agent/phases.md) M7: "sampled LLM-judge on live traces; thumbs up/down in the chat; failing traces promoted into the golden set".
- **What exists:**
  - **Every turn runs in an `agent.turn` span** (spec 017). The span records the turn's outcome (`answered`, `confirm_required`, `gave_up`, `refused`, `error` or `aborted`), whether it escalated, and how many tools it called.
  - **The `done` event carries only `threadId`.** Nothing yet names the reply a customer would rate.
  - **Checkpoints** (MongoDB, 30-day TTL) hold every message with an id. They're keyed by user, so only the owner can read a thread.
  - **Spec 016's guard:** `redact()` and `findSensitive()` keep card numbers and credentials out.
  - **The backend runs on Vercel serverless functions** (`api/index.ts`). Work after the response ends isn't guaranteed to run, so judging can't happen in the background of a request.
  - **Frontend:** `features/shopping-agent`, with `AssistantMessage`, `useAgentChat` and `agent-chat.service`. The SSE types are in `types/index.ts`.
  - **Spec 020's agent goldens** (`evals/agent/goldens.json`) are where promoted cases go.
- **M7 split** (spec 018): 018 ✅, 019 ✅, 020 ✅ (its real-model run is parked until the keys are set), **021 this spec**, 022 launch.

## Scope

**In:**
- **Backend:** the feedback endpoint, sampling of live turns, the online judge script, and the review CLI.
- **Frontend:** thumbs on assistant replies.
- **CI:** a scheduled job that runs the judge.
- **Docs.**

**Out:**
- **An admin UI for review.** The CLI is enough for one owner.
- **LangSmith's own feedback API.**
- **Automatic changes** to the prompt or the models.
- **Automatic promotion into the goldens.** That's always a human step.
- **Layer 7 business KPIs.**

## Design

**Identifying a reply.**
- `done` gains `replyId`: the id of the turn's last assistant message in the checkpoint. Every checkpointed message has an id.
- The `agent.turn` span gets an `agent.reply_id` attribute. Feedback can then be matched to its trace in LangSmith without sending trace ids to the browser.

**Feedback** — `POST /api/v1/agent/feedback`, taking `{ threadId, replyId, rating: 'up' | 'down', reason?, comment? }`:
- **Signed-in customers only,** with the same auth and `agentAvailable` checks as chat.
- **Validated with Zod:**
  - `reason` is one of `wrong_answer`, `wrong_action`, `didnt_understand` or `other`.
  - `comment` is at most 300 characters.
- **Sensitive data:** a card number or password in the comment gets a 400, the same as in a chat message (spec 016).
- **Ownership:** the reply must exist in the caller's own checkpoint thread. Otherwise the answer is 404, so nobody can rate another customer's turn.
- **Storage:** an upsert into `agent_feedback`, one record per user and reply. Changing your mind replaces the vote.
- **On a thumbs-down,** the turn (the customer's message through the reply) is saved, redacted. Review then still works after the checkpoint expires.
- **Limits:** a small per-user limit through the existing `limitRequests`.
- **Logs:** an `AGENT_FEEDBACK` line with the ids and the rating, no text.

**Sampling live turns** — at the end of `runChatTurn`, a share of finished turns is saved to `agent_turn_samples`:
- **Which turns:** those whose outcome is `answered`, `gave_up` or `refused`. The share is `AGENT_EVAL_SAMPLE_RATE` (open question 2).
- **What's saved:**
  - the customer's message
  - the tool calls, with their arguments and results (results truncated)
  - the reply and its id, the outcome, whether it escalated, and the prompt version
  - all of it redacted
- **Cost to the request:** one small insert before the stream closes. No model call ever runs inside a customer's request.
- **Failures:** a failed insert is logged and ignored. The customer's turn is never affected.

**The online judge** — `npm run eval:online` (`evals/online/judge.ts`) runs one batch:
- **What it judges:** samples that have no score yet, up to a daily cap. Haiku 5.5 judges them through deepeval on three metrics:
  - **faithfulness:** the reply against the tool results, given as context
  - **answer relevancy**
  - **tool fit:** a `GEval` rubric for whether the tools called fit the request
- **Flags:** the scores are written back onto the sample. A sample is flagged when it scores below a threshold:

  | Metric | Flagged below |
  |---|---|
  | Faithfulness | 0.9 |
  | Answer relevancy | 0.8 |
  | Tool fit | 0.7 |

  The first two thresholds come from `evals.md` §2; §2 sets none for tool fit.
- **Summary:** the mean scores, the number flagged, the thumbs up/down ratio and the mix of outcomes (the task-success proxy). It goes to stdout and the CI job summary, **with no customer text**.
- **Where and when:** daily, in GitHub Actions (open question 1). It skips without its secrets.

**Review and promotion** — `npm run agent:review`, which the owner runs locally:
- **The list:** flagged turns (thumbs-down and judge flags), newest first, each with its redacted snapshot.
- **Closing one:** `--resolve <id> --as promoted|dismissed [--note]`.
- **Promotion means hand-writing a new golden** in `evals/agent/goldens.json`. It reproduces the problem with the seeded catalog and the test customers.
  - Real customer text never goes into the repository.
  - The golden's `id` shows where it came from (e.g. `online-…`).

**Retention:** samples and feedback snapshots expire through TTL indexes. Flagged ones are kept until reviewed, up to a limit (open question 3).

**Frontend:**
- **Where the thumbs show:** under each finished assistant reply. Never while it streams, on a pending confirmation, or on an error.
- **Thumbs down** opens an optional reason picker and a comment box, sent with "Send". A single tap still counts on its own.
- **After a vote,** the chosen thumb stays selected. A failed send shows a quiet retry and never blocks the chat.
- **Code changes:**
  - `useAgentChat` keeps the `replyId` from `done` on the message.
  - `agent-chat.service` gains `sendFeedback`.
  - The `done` type gains `replyId`.

## Tasks

**Backend:**
- [x] `replyId` on `done`, and the `agent.reply_id` span attribute
- [x] Feedback: the model, route and controller, with tests
- [x] Sampling at the end of a turn, with tests
- [x] TTL indexes, created by `agent:setup`
- [x] `evals/online/judge.ts` and `npm run eval:online`, with keyless tests of the batch logic (selection, cap, flagging, summary) using a stub judge
- [x] The `agent:review` CLI, with tests
- [x] The CI `online-evals` job

**Frontend:**
- [x] Thumbs and the reason picker on assistant messages
- [x] `sendFeedback`, and `replyId` on the `done` type
- [x] Tests

**Docs:**
- [x] `evals.md` §12 and `observability.md` Layer 6 (what's built), `phases.md` §0 and the spec index

## Acceptance criteria

- [x] **Feedback** — HTTP tests with MongoDB:
  - A customer can rate a reply, and changing the vote replaces it.
  - Rating another customer's reply returns 404.
  - A card number in the comment returns 400.
- [x] **Sampling** — tests:
  - At rate 1, every eligible turn is saved, redacted. At rate 0, none is.
  - A failing insert doesn't affect the turn.
- [x] **The judge:**
  - `npm run eval:online` skips cleanly without keys.
  - With a stub judge, it scores only unjudged samples, stops at the cap, flags samples below the thresholds, and prints a summary with no customer text — tests.
- [x] **Review:** `agent:review` lists flagged turns and resolves one — test.
- [x] **Frontend** — tests:
  - Thumbs appear only on finished replies.
  - A vote sends the right body.
  - The reason picker appears on a thumbs-down.
  - A failed send doesn't block the chat.
- [x] **Checks:**
  - **Backend:** lint 0 errors, build, `npm test` with and without `MONGO_URL` / `ATLAS_URL`, CI green.
  - **Frontend:** lint, typecheck, tests and build.
- [ ] **With keys and secrets** (parked until they're set): the first real judged batch, with its summary recorded here.

## Test plan

- **Backend:**
  - HTTP tests for the feedback route, against MongoDB.
  - Unit tests for sampling and redaction.
  - The judge's batch logic and the review CLI, against MongoDB with a stub judge.
- **Frontend:** component and hook tests for the thumbs, the request body and failure handling.
- **With keys:** one real `npm run eval:online` batch on a few seeded samples, or the CI job started by hand. The summary is recorded here.

## Open questions

_None — resolved 2026-10-26, see the decision log._

## Results

**2026-10-26.**

**Backend:**
- **Files:**
  - `src/agent/online-evals.ts`: snapshots, the two collections, retention, indexes
  - the reply id and sampling in `src/agent/chat.service.ts`
  - `POST /agent/feedback` in `agent.controller.ts` and `agent.routes.ts`
  - the `feedback` limit in `limits.ts` (60 an hour)
  - `AGENT_EVAL_SAMPLE_RATE` in `config.ts` (default 0.1)
  - the indexes in `agent:setup`
  - `evals/online/` (`online.ts` for the batch, summary and review queue; `judge.ts`; `review.ts`)
  - the `online-evals` CI job, daily at 05:23 UTC
- **Tests:**
  - `online-evals.test.ts` (4)
  - `routes/agent.feedback.mongo.test.ts` (10): the reply id, the feedback route and sampling over HTTP with MongoDB
  - `evals/online/online.mongo.test.ts` (5): the batch with a stub judge, and the review queue
- **Checks:** lint 0 errors; build clean; `npm test` 320 with both databases (301 before, plus 19), and 247 pass and 73 skip without them.
- **CLIs:**
  - `npm run eval:online` skips cleanly without a key. Against an empty local database with a dummy key, it prints an empty summary.
  - `npm run agent:review` lists and resolves against a local database.

**Frontend:**
- **Files:**
  - `components/FeedbackBar.tsx`, shown by `MessageList` under each finished reply the server named
  - `rate` in `useAgentChat`; `sendFeedback` in `agent-chat.service.ts`
  - `replyId` and `feedback` in the types
- **Tests:** 5 new chat-panel tests. Lint has no errors (the 3 warnings are in unrelated files); Prettier, typecheck, 74 tests and the build pass.

**On GitHub:**
- **Run #11** on `fba693c` was red. The new feedback route test failed to load because CI sets no Cloudinary variables: the test imports the route, which loads the auth service, and that service checks those settings on import. Locally I had exported dummy values, which hid it.
- **The fix (`826f763`)** gives the test its own defaults, as the safety harness does. It was reproduced locally without the variables first, then shown passing.
- **Run #13** (on `38fe7dd`, which includes the fix) is green. #12 was cancelled by that newer push.

**Parked until the keys and secrets are set:**
- the first real judged batch: `npm run eval:online` with `ANTHROPIC_API_KEY` and a database URL, or the CI `online-evals` job started by hand
- its summary, recorded here

**Owner settings** (in GitHub and MongoDB Atlas):
- **A restricted Atlas database user**, with read and write access to `agent_turn_samples` and `agent_feedback` only. Its connection string goes in the repository secret `ONLINE_EVALS_DATABASE_URL`.
- **Run `npm run agent:setup`** against production once, for the new indexes.
- **The daily schedule** starts once the workflow is on `main`.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-26 | Approved with the defaults: the judge runs daily in GitHub Actions with its own restricted database secret; 10% of turns sampled, at most 200 judged a day; unflagged records kept 30 days, flagged up to 90 until reviewed; four optional reasons plus an optional comment of up to 300 characters | Owner's choice |
| 2026-10-26 | A reply is identified by its checkpointed message id (`replyId`), and the feedback route checks it against the caller's own checkpoint | Every checkpointed message already has an id, and the checkpoint key includes the user id, so ownership needs no new record |
| 2026-10-26 | Feedback has its own per-user limit (60 an hour) instead of sharing the chat budget | Rating a reply shouldn't use up the customer's messages |
| 2026-10-26 | A thumbs-down is sent at once. The reason and comment follow as a second vote that replaces the first | A single tap counts even if the customer never fills in the form |
| 2026-10-26 | Sampled turns store the user id hashed; feedback stores it in plain | The judge never needs to know who it was. A vote needs the id so the same customer's next vote replaces it |
| 2026-10-26 | Faithfulness is judged only on turns that called a tool | With no tool results there's nothing for the reply to be faithful to |
| 2026-10-26 | The flag below 0.7 for tool fit is new; faithfulness (0.9) and relevancy (0.8) follow `evals.md` §2 | §2 sets no bar for the tools fitting the request |
| 2026-10-26 | The feedback route test sets its own Cloudinary defaults | CI run #11 failed without them; the test runs anywhere now |
| 2026-10-26 | The weekly judged-evals job now keys on its own cron, since the workflow has a second (daily) schedule | Each schedule runs only its own job |
