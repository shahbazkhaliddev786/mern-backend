// Online evals (spec 021, evals.md §12): live turns sampled for the daily Haiku judge, and the
// customers' thumbs up/down. Both keep a redacted snapshot of the turn, so a flagged one can still
// be reviewed after its checkpoint expires. TTL indexes come from `npm run agent:setup`.

import type { BaseMessage } from '@langchain/core/messages';
import mongoose, { type Connection } from 'mongoose';
import { redact } from './guard.js';
import { visibleText } from './stream.js';

export const TURN_SAMPLES_COLLECTION = 'agent_turn_samples';
export const FEEDBACK_COLLECTION = 'agent_feedback';

// Spec 021: unflagged records go with the checkpoints; flagged ones wait for review, up to a limit.
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_DAYS = { unflagged: 30, flagged: 90 } as const;
export const expiresAfter = (days: number, from = new Date()) => new Date(from.getTime() + days * DAY_MS);

/** Tool results are long (product lists, orders); the judge needs the gist, not all of it. */
const RESULT_LIMIT = 2000;

export interface TurnSnapshot {
  /** The customer's message that started the turn. */
  message: string;
  calls: { name: string; args: string; result: string }[];
  reply: string;
}

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

export interface Review {
  status: 'promoted' | 'dismissed';
  note?: string;
  at: Date;
}

export interface TurnSample {
  /** Hashed, as in the turn's span: the judge never needs to know who it was. */
  user: string;
  threadId: string;
  replyId: string;
  createdAt: Date;
  expiresAt: Date;
  promptVersion: number;
  outcome: string;
  escalated: boolean;
  snapshot: TurnSnapshot;
  /** Set by the online judge. */
  scores?: Record<string, number>;
  judgedAt?: Date;
  /** The metrics below their thresholds; empty when none. */
  flags?: string[];
  review?: Review;
}

export const FEEDBACK_REASONS = ['wrong_answer', 'wrong_action', 'didnt_understand', 'other'] as const;

export interface Feedback {
  userId: string;
  threadId: string;
  replyId: string;
  rating: 'up' | 'down';
  reason?: (typeof FEEDBACK_REASONS)[number];
  comment?: string;
  /** Kept on a thumbs-down, for review. */
  snapshot?: TurnSnapshot;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  review?: Review;
}

const db = (connection: Connection) => {
  if (!connection.db) throw new Error('Online evals need an open MongoDB connection');
  return connection.db;
};
export const turnSamples = (connection: Connection = mongoose.connection) => db(connection).collection<TurnSample>(TURN_SAMPLES_COLLECTION);
export const feedbackRecords = (connection: Connection = mongoose.connection) => db(connection).collection<Feedback>(FEEDBACK_COLLECTION);

export async function saveTurnSample(sample: Omit<TurnSample, 'createdAt' | 'expiresAt'>, connection?: Connection): Promise<void> {
  const now = new Date();
  await turnSamples(connection).insertOne({ ...sample, createdAt: now, expiresAt: expiresAfter(RETENTION_DAYS.unflagged, now) });
}

/** One vote per customer and reply: a new vote replaces the old one. */
export async function saveFeedback(
  vote: Pick<Feedback, 'userId' | 'threadId' | 'replyId' | 'rating' | 'reason' | 'comment' | 'snapshot'>,
  connection?: Connection,
): Promise<void> {
  const now = new Date();
  const down = vote.rating === 'down';
  const set: Partial<Feedback> = {
    threadId: vote.threadId,
    rating: vote.rating,
    updatedAt: now,
    expiresAt: expiresAfter(down ? RETENTION_DAYS.flagged : RETENTION_DAYS.unflagged, now),
    ...(vote.reason ? { reason: vote.reason } : {}),
    ...(vote.comment ? { comment: vote.comment } : {}),
    ...(down && vote.snapshot ? { snapshot: vote.snapshot } : {}),
  };
  // A changed vote drops what no longer applies (a thumbs-up keeps no snapshot, reason or comment).
  const unset: Record<string, ''> = Object.fromEntries((['reason', 'comment', 'snapshot', 'review'] as const).filter((key) => !(key in set)).map((key) => [key, '' as const]));
  await feedbackRecords(connection).updateOne(
    { userId: vote.userId, replyId: vote.replyId },
    { $set: set, $setOnInsert: { createdAt: now }, ...(Object.keys(unset).length ? { $unset: unset } : {}) } as mongoose.mongo.UpdateFilter<Feedback>,
    { upsert: true },
  );
}

/** For `npm run agent:setup`: expiry, one vote per customer and reply, and the judge's queue. */
export async function ensureOnlineEvalIndexes(connection: Connection = mongoose.connection): Promise<void> {
  await turnSamples(connection).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await turnSamples(connection).createIndex({ judgedAt: 1, createdAt: 1 });
  await feedbackRecords(connection).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await feedbackRecords(connection).createIndex({ userId: 1, replyId: 1 }, { unique: true });
}
