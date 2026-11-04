// The shopping agent's own tables (spec 023). The checkpointer (PostgresSaver) and the rate
// limiters (RateLimiterPostgres) create and manage their own tables, so they aren't here.

import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, vector } from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/** A confirmation claimed by a resume, so only one request runs it (spec 002). */
export const agentConfirmClaims = pgTable(
  'agent_confirm_claims',
  {
    interruptId: text('interrupt_id').primaryKey(),
    thread: text('thread').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Kept as long as the conversation's checkpoints (30 days).
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
  },
  (t) => [index('agent_confirm_claims_expires_at_idx').on(t.expiresAt)],
);

export interface TurnSnapshotJson {
  message: string;
  calls: { name: string; args: string; result: string }[];
  reply: string;
}
export interface ReviewJson {
  status: 'promoted' | 'dismissed';
  note?: string;
  at: string;
}

/** Thumbs up/down on a reply (spec 021): one vote per customer and reply. */
export const agentFeedback = pgTable(
  'agent_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    threadId: text('thread_id').notNull(),
    replyId: text('reply_id').notNull(),
    rating: text('rating', { enum: ['up', 'down'] }).notNull(),
    reason: text('reason'),
    comment: text('comment'),
    snapshot: jsonb('snapshot').$type<TurnSnapshotJson>(),
    review: jsonb('review').$type<ReviewJson>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [unique('agent_feedback_user_reply_unique').on(t.userId, t.replyId), index('agent_feedback_expires_at_idx').on(t.expiresAt)],
);

/** Live turns saved for the online judge (spec 021). */
export const agentTurnSamples = pgTable(
  'agent_turn_samples',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user: text('user_hash').notNull(),
    threadId: text('thread_id').notNull(),
    replyId: text('reply_id').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    outcome: text('outcome').notNull(),
    escalated: boolean('escalated').notNull(),
    snapshot: jsonb('snapshot').$type<TurnSnapshotJson>().notNull(),
    scores: jsonb('scores').$type<Record<string, number>>(),
    judgedAt: timestamp('judged_at', { withTimezone: true }),
    flags: text('flags').array(),
    review: jsonb('review').$type<ReviewJson>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('agent_turn_samples_queue_idx').on(t.judgedAt, t.createdAt), index('agent_turn_samples_expires_at_idx').on(t.expiresAt)],
);

/** The store-knowledge chunks (spec 013), searched by meaning (pgvector) and by words (full text). */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: text('id').primaryKey(),
    file: text('file').notNull(),
    title: text('title').notNull(),
    question: text('question').notNull(),
    text: text('text').notNull(),
    // Haiku's one-line context, or null when it couldn't be written.
    context: text('context'),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    contentHash: text('content_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // The keyword side of the hybrid search, weighted like the Atlas index's fields.
    search: tsvector('search').generatedAlwaysAs(
      sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(question, '')), 'A') || setweight(to_tsvector('english', coalesce(context, '')), 'B') || setweight(to_tsvector('english', coalesce(text, '')), 'C')`,
    ),
  },
  (t) => [index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')), index('knowledge_chunks_search_idx').using('gin', t.search)],
);
