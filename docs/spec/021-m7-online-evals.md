# 021 — Online evals and feedback

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M7 — Evals & launch gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-26 |
| **Updated** | 2026-10-26 |
| **Closed by** | — |
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
- [ ] `replyId` on `done`, and the `agent.reply_id` span attribute
- [ ] Feedback: the model, route and controller, with tests
- [ ] Sampling at the end of a turn, with tests
- [ ] TTL indexes, created by `agent:setup`
- [ ] `evals/online/judge.ts` and `npm run eval:online`, with keyless tests of the batch logic (selection, cap, flagging, summary) using a stub judge
- [ ] The `agent:review` CLI, with tests
- [ ] The CI `online-evals` job

**Frontend:**
- [ ] Thumbs and the reason picker on assistant messages
- [ ] `sendFeedback`, and `replyId` on the `done` type
- [ ] Tests

**Docs:**
- [ ] `evals.md` §12 and `observability.md` Layer 6 (what's built), `phases.md` §0 and the spec index

## Acceptance criteria

- [ ] **Feedback** — HTTP tests with MongoDB:
  - A customer can rate a reply, and changing the vote replaces it.
  - Rating another customer's reply returns 404.
  - A card number in the comment returns 400.
- [ ] **Sampling** — tests:
  - At rate 1, every eligible turn is saved, redacted. At rate 0, none is.
  - A failing insert doesn't affect the turn.
- [ ] **The judge:**
  - `npm run eval:online` skips cleanly without keys.
  - With a stub judge, it scores only unjudged samples, stops at the cap, flags samples below the thresholds, and prints a summary with no customer text — tests.
- [ ] **Review:** `agent:review` lists flagged turns and resolves one — test.
- [ ] **Frontend** — tests:
  - Thumbs appear only on finished replies.
  - A vote sends the right body.
  - The reason picker appears on a thumbs-down.
  - A failed send doesn't block the chat.
- [ ] **Checks:**
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

1. **Where the online judge runs.**
   - **Recommended:** a daily `online-evals` job in the existing GitHub Actions workflow. It uses two repository secrets:
     - `ONLINE_EVALS_DATABASE_URL`: a MongoDB Atlas user that can only read and write the two agent collections (and read checkpoints, if that's needed)
     - `ANTHROPIC_API_KEY`
   - That keeps model calls out of customer requests and needs no new public endpoint.
   - **Alternatives:**
     - A Vercel cron endpoint: a new authenticated route, and judging counts against function time.
     - Running it by hand only.
2. **Sample rate and cap.**
   - **Recommended:** 10% of eligible turns (`AGENT_EVAL_SAMPLE_RATE=0.1`), and at most 200 judged per day (`ONLINE_EVAL_DAILY_CAP`).
   - With Haiku 5.5 at $0.10 / $0.50 per million tokens, three metrics on 200 turns costs a few cents a day.
   - Both are tuned after launch.
3. **Retention.**
   - **Recommended:** unflagged samples and thumbs-up records expire after 30 days, the same as checkpoints.
   - Flagged samples and thumbs-down snapshots are kept until reviewed, for at most 90 days.
   - Snapshots are always redacted, and goldens never copy customer text.
4. **How much detail a thumbs-down asks for.**
   - **Recommended:** four preset reasons plus an optional comment of up to 300 characters, both optional, so a single tap still counts.

## Decision log

| Date | Decision | Why |
|---|---|---|
