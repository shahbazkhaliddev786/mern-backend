// Online evals (spec 021): one batch of the daily judge over sampled live turns, the summary it
// prints (no customer text), and the review queue of flagged turns. The judge itself is passed
// in, so this runs with a stub in tests and with Haiku 5.5 in `npm run eval:online`.

import { and, asc, count, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../../src/db/client.js';
import { agentFeedback, agentTurnSamples } from '../../src/db/schema/index.js';
import { expiresAfter, RETENTION_DAYS, type Review, type TurnSnapshot } from '../../src/agent/online-evals.js';
import { isId } from '../../src/utils/ids.js';

/** A sample is flagged when any score is below its threshold (evals.md §2; tool fit, spec 021). */
export const ONLINE_THRESHOLDS = { faithfulness: 0.9, relevancy: 0.8, toolFit: 0.7 } as const;
export type OnlineMetric = keyof typeof ONLINE_THRESHOLDS;

/** Scores one turn. A metric that doesn't apply (faithfulness with no tool results) is left out. */
export type Judge = (snapshot: TurnSnapshot) => Promise<Partial<Record<OnlineMetric, number>>>;

export interface BatchSummary {
  date: string;
  cap: number;
  judged: number;
  errors: number;
  flagged: number;
  /** Unjudged samples left after this batch. */
  waiting: number;
  means: Partial<Record<OnlineMetric, number>>;
  flaggedBy: Partial<Record<OnlineMetric, number>>;
  /** The last 7 days. */
  thumbs: { up: number; down: number };
  outcomes: Record<string, number>;
}

const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

// Expired records are left out of every read, as the TTL indexes removed them, whether or not the
// cleanup has run yet (spec 023).
const liveSample = (now: Date) => gt(agentTurnSamples.expiresAt, now);
const liveVote = (now: Date) => gt(agentFeedback.expiresAt, now);

export async function judgeBatch({ judge, cap, now = new Date(), db = getDb() }: { judge: Judge; cap: number; now?: Date; db?: Executor }): Promise<BatchSummary> {
  const unjudged = and(isNull(agentTurnSamples.judgedAt), liveSample(now));
  const [today] = await db
    .select({ n: count() })
    .from(agentTurnSamples)
    .where(gte(agentTurnSamples.judgedAt, startOfUtcDay(now)));
  const pending = await db
    .select()
    .from(agentTurnSamples)
    .where(unjudged)
    .orderBy(asc(agentTurnSamples.createdAt))
    .limit(Math.max(0, cap - (today?.n ?? 0)));

  const scored: Partial<Record<OnlineMetric, number>>[] = [];
  let errors = 0;
  let flagged = 0;
  const flaggedBy: Partial<Record<OnlineMetric, number>> = {};
  for (const sample of pending) {
    let scores: Partial<Record<OnlineMetric, number>>;
    try {
      scores = await judge(sample.snapshot);
    } catch {
      // Left unjudged, so the next batch tries again. Nothing about the turn is printed.
      errors += 1;
      continue;
    }
    const flags = (Object.keys(ONLINE_THRESHOLDS) as OnlineMetric[]).filter((metric) => scores[metric] !== undefined && scores[metric]! < ONLINE_THRESHOLDS[metric]);
    for (const metric of flags) flaggedBy[metric] = (flaggedBy[metric] ?? 0) + 1;
    if (flags.length) flagged += 1;
    scored.push(scores);
    await db
      .update(agentTurnSamples)
      // A flagged turn is kept for review, up to 90 days from when it happened (spec 021).
      .set({ scores, flags, judgedAt: now, ...(flags.length ? { expiresAt: expiresAfter(RETENTION_DAYS.flagged, sample.createdAt) } : {}) })
      .where(eq(agentTurnSamples.id, sample.id));
  }

  const means: Partial<Record<OnlineMetric, number>> = {};
  for (const metric of Object.keys(ONLINE_THRESHOLDS) as OnlineMetric[]) {
    const values = scored.map((s) => s[metric]).filter((v): v is number => v !== undefined);
    if (values.length) means[metric] = values.reduce((sum, v) => sum + v, 0) / values.length;
  }
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const votes = await db
    .select({ rating: agentFeedback.rating, n: count() })
    .from(agentFeedback)
    .where(and(gte(agentFeedback.updatedAt, weekAgo), liveVote(now)))
    .groupBy(agentFeedback.rating);
  const outcomes = await db
    .select({ outcome: agentTurnSamples.outcome, n: count() })
    .from(agentTurnSamples)
    .where(and(gte(agentTurnSamples.createdAt, weekAgo), liveSample(now)))
    .groupBy(agentTurnSamples.outcome);
  const [waiting] = await db.select({ n: count() }).from(agentTurnSamples).where(unjudged);
  return {
    date: now.toISOString().slice(0, 10),
    cap,
    judged: scored.length,
    errors,
    flagged,
    waiting: waiting?.n ?? 0,
    means,
    flaggedBy,
    thumbs: { up: votes.find((v) => v.rating === 'up')?.n ?? 0, down: votes.find((v) => v.rating === 'down')?.n ?? 0 },
    outcomes: Object.fromEntries(outcomes.sort((a, b) => b.n - a.n).map((o) => [o.outcome, o.n])),
  };
}

/** Counts and scores only: the summary goes to the CI job page, so it never holds customer text. */
export function renderSummary(s: BatchSummary): string {
  const metrics = Object.keys(ONLINE_THRESHOLDS) as OnlineMetric[];
  const outcomes = Object.entries(s.outcomes).map(([outcome, n]) => `${outcome} ${n}`);
  return [
    `### Online evals — ${s.date}`,
    '',
    `Judged ${s.judged} turn(s) (daily cap ${s.cap}; ${s.waiting} waiting) · ${s.flagged} flagged · ${s.errors} error(s)`,
    '',
    '| Metric | Mean | Flagged below | Flagged |',
    '|---|---|---|---|',
    ...metrics.map((m) => `| ${m} | ${s.means[m] === undefined ? '—' : s.means[m]!.toFixed(2)} | ${ONLINE_THRESHOLDS[m]} | ${s.flaggedBy[m] ?? 0} |`),
    '',
    `Thumbs, last 7 days: ${s.thumbs.up} up · ${s.thumbs.down} down`,
    `Sampled turns by outcome, last 7 days: ${outcomes.length ? outcomes.join(' · ') : 'none'}`,
    '',
  ].join('\n');
}

// --- The review queue (`npm run agent:review`).

export interface Flagged {
  /** `s:` a judged sample, `f:` a customer's thumbs-down; then the record id. */
  id: string;
  at: Date;
  why: string;
  snapshot?: TurnSnapshot;
}

export async function listFlagged(db: Executor = getDb(), now = new Date()): Promise<Flagged[]> {
  const samples = await db
    .select()
    .from(agentTurnSamples)
    .where(and(sql`cardinality(${agentTurnSamples.flags}) > 0`, isNull(agentTurnSamples.review), liveSample(now)));
  const votes = await db
    .select()
    .from(agentFeedback)
    .where(and(eq(agentFeedback.rating, 'down'), isNull(agentFeedback.review), liveVote(now)));
  const fromSamples = samples.map((s) => ({
    id: `s:${s.id}`,
    at: s.createdAt,
    why: `judge: ${(s.flags ?? []).map((f) => `${f} ${s.scores?.[f]?.toFixed(2) ?? '?'}`).join(', ')}`,
    snapshot: s.snapshot,
  }));
  const fromVotes = votes.map((v) => ({
    id: `f:${v.id}`,
    at: v.updatedAt,
    why: `thumbs down${v.reason ? ` (${v.reason})` : ''}${v.comment ? `: "${v.comment}"` : ''}`,
    ...(v.snapshot ? { snapshot: v.snapshot } : {}),
  }));
  return [...fromSamples, ...fromVotes].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Closes a flagged turn. It then expires like an unflagged one (30 days from when it happened). */
export async function resolveFlagged(id: string, status: Review['status'], note: string | undefined, db: Executor = getDb()): Promise<boolean> {
  const [kind, raw] = id.split(':');
  if (!raw || !isId(raw) || (kind !== 's' && kind !== 'f')) return false;
  const review: Review = { status, at: new Date().toISOString(), ...(note ? { note } : {}) };
  const table = kind === 's' ? agentTurnSamples : agentFeedback;
  const done = await db
    .update(table)
    // In seconds, as expiresAfter counts: a day interval would follow the session's daylight saving.
    .set({ review, expiresAt: sql`${table.createdAt} + make_interval(secs => ${RETENTION_DAYS.unflagged * 86_400})` })
    .where(eq(table.id, raw))
    .returning({ id: table.id });
  return done.length > 0;
}

export function renderFlagged(items: Flagged[]): string {
  if (!items.length) return 'Nothing flagged.';
  return items
    .map((item) => {
      const snap = item.snapshot;
      const lines = [`${item.id} · ${item.at.toISOString()} · ${item.why}`];
      if (snap) {
        lines.push(`  Customer: ${snap.message}`);
        for (const call of snap.calls) lines.push(`  Tool: ${call.name}(${call.args}) → ${call.result.slice(0, 300)}`);
        lines.push(`  Assistant: ${snap.reply}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
