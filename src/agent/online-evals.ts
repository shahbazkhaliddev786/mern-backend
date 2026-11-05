// Online evals (spec 021, evals.md §12): live turns sampled for the daily Haiku judge, and the
// customers' thumbs up/down. Both keep a redacted snapshot of the turn, so a flagged one can still
// be reviewed after its checkpoint expires. Each row carries its `expires_at` (spec 023).

import type { BaseMessage } from '@langchain/core/messages';
import { sql } from 'drizzle-orm';
import { getDb, type Executor } from '../db/client.js';
import { agentFeedback, agentTurnSamples, type ReviewJson, type TurnSnapshotJson } from '../db/schema/index.js';
import { redact } from './guard.js';
import { visibleText } from './stream.js';

// Spec 021: unflagged records go with the checkpoints; flagged ones wait for review, up to a limit.
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = { unflagged: 30, flagged: 90 } as const;
export const expiresAfter = (days: number, from = new Date()) => new Date(from.getTime() + days * DAY_MS);

/** Tool results are long (product lists, orders); the judge needs the gist, not all of it. */
const RESULT_LIMIT = 2000;

/** The customer's message that started the turn, the tools it ran, and the reply; all redacted. */
export type TurnSnapshot = TurnSnapshotJson;

const typeOf = (m: BaseMessage) => m.getType();

/**
 * The turn ending at `replyIndex`: from the customer's message before it through the reply,
 * redacted (spec 016). Null when that message isn't a reply.
 */
export function snapshotTurn(messages: BaseMessage[], replyIndex = messages.length - 1): TurnSnapshot | null {
  const reply = messages[replyIndex];
  if (!reply || typeOf(reply) !== 'ai') return null;
  let start = replyIndex;
  while (start >= 0 && typeOf(messages[start]!) !== 'human') start -= 1;
  if (start < 0) return null;
  const turn = messages.slice(start + 1, replyIndex + 1);
  const results = new Map<string, string>();
  for (const m of turn) if (typeOf(m) === 'tool') results.set((m as unknown as { tool_call_id: string }).tool_call_id, visibleText(m.content));
  const calls = turn.flatMap((m) =>
    typeOf(m) === 'ai'
      ? ((m as unknown as { tool_calls?: { id?: string; name: string; args: unknown }[] }).tool_calls ?? []).map((call) => ({
          name: call.name,
          args: redact(JSON.stringify(call.args ?? {})),
          result: redact((results.get(call.id ?? '') ?? '').slice(0, RESULT_LIMIT)),
        }))
      : [],
  );
  return { message: redact(visibleText(messages[start]!.content)), calls, reply: redact(visibleText(reply.content)) };
}

/** A reviewer's decision on a flagged turn; `at` is an ISO date, as stored. */
export type Review = ReviewJson;

/** A sampled turn, with the judge's scores once it has run. */
export type TurnSample = typeof agentTurnSamples.$inferSelect;
/** What a finished turn saves; the judge fills in the rest. */
export type NewTurnSample = Pick<TurnSample, 'user' | 'threadId' | 'replyId' | 'promptVersion' | 'outcome' | 'escalated' | 'snapshot'>;

export const FEEDBACK_REASONS = ['wrong_answer', 'wrong_action', 'didnt_understand', 'other'] as const;

/** A customer's vote on a reply; a thumbs-down keeps its snapshot for review. */
export type Feedback = typeof agentFeedback.$inferSelect;
export interface Vote {
  userId: string;
  threadId: string;
  replyId: string;
  rating: 'up' | 'down';
  reason?: (typeof FEEDBACK_REASONS)[number];
  comment?: string;
  snapshot?: TurnSnapshot;
}

export async function saveTurnSample(sample: NewTurnSample, db: Executor = getDb()): Promise<void> {
  const now = new Date();
  await db.insert(agentTurnSamples).values({ ...sample, createdAt: now, expiresAt: expiresAfter(RETENTION_DAYS.unflagged, now) });
}

/**
 * One vote per customer and reply: a new vote replaces the old one, in one statement. A changed
 * vote drops what no longer applies (a thumbs-up keeps no snapshot, reason or comment). Spec 022:
 * the same vote again keeps its review decision (and the expiry that came with it); a changed
 * vote is new information, so it goes back to the queue.
 */
export async function saveFeedback(vote: Vote, db: Executor = getDb()): Promise<void> {
  const now = new Date();
  const down = vote.rating === 'down';
  const sameRating = sql`${agentFeedback.rating} = excluded.rating`;
  await db
    .insert(agentFeedback)
    .values({
      userId: vote.userId,
      threadId: vote.threadId,
      replyId: vote.replyId,
      rating: vote.rating,
      reason: vote.reason ?? null,
      comment: vote.comment ?? null,
      snapshot: down && vote.snapshot ? vote.snapshot : null,
      createdAt: now,
      updatedAt: now,
      expiresAt: expiresAfter(down ? RETENTION_DAYS.flagged : RETENTION_DAYS.unflagged, now),
    })
    .onConflictDoUpdate({
      target: [agentFeedback.userId, agentFeedback.replyId],
      set: {
        threadId: sql`excluded.thread_id`,
        rating: sql`excluded.rating`,
        reason: sql`excluded.reason`,
        comment: sql`excluded.comment`,
        snapshot: sql`excluded.snapshot`,
        updatedAt: sql`excluded.updated_at`,
        review: sql`case when ${sameRating} then ${agentFeedback.review} end`,
        expiresAt: sql`case when ${sameRating} and ${agentFeedback.review} is not null then ${agentFeedback.expiresAt} else excluded.expires_at end`,
      },
    });
}
