// Online evals (spec 021): one batch of the daily judge over sampled live turns, the summary it
// prints (no customer text), and the review queue of flagged turns. The judge itself is passed
// in, so this runs with a stub in tests and with Haiku 5.5 in `npm run eval:online`.

import mongoose, { type Connection } from 'mongoose';
import { expiresAfter, feedbackRecords, RETENTION_DAYS, turnSamples, type Review, type TurnSample, type TurnSnapshot } from '../../src/agent/online-evals.js';

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

export async function judgeBatch({ judge, cap, now = new Date(), connection = mongoose.connection }: { judge: Judge; cap: number; now?: Date; connection?: Connection }): Promise<BatchSummary> {
  const samples = turnSamples(connection);
  const judgedToday = await samples.countDocuments({ judgedAt: { $gte: startOfUtcDay(now) } });
  const pending = await samples
    .find({ judgedAt: { $exists: false } })
    .sort({ createdAt: 1 })
    .limit(Math.max(0, cap - judgedToday))
    .toArray();

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
    await samples.updateOne(
      { _id: sample._id },
      // A flagged turn is kept for review, up to 90 days from when it happened (spec 021).
      { $set: { scores, flags, judgedAt: now, ...(flags.length ? { expiresAt: expiresAfter(RETENTION_DAYS.flagged, sample.createdAt) } : {}) } },
    );
  }

  const means: Partial<Record<OnlineMetric, number>> = {};
  for (const metric of Object.keys(ONLINE_THRESHOLDS) as OnlineMetric[]) {
    const values = scored.map((s) => s[metric]).filter((v): v is number => v !== undefined);
    if (values.length) means[metric] = values.reduce((sum, v) => sum + v, 0) / values.length;
  }
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const votes = await feedbackRecords(connection)
    .aggregate<{ _id: string; n: number }>([{ $match: { updatedAt: { $gte: weekAgo } } }, { $group: { _id: '$rating', n: { $sum: 1 } } }])
    .toArray();
  const outcomes = await samples
    .aggregate<{ _id: string; n: number }>([{ $match: { createdAt: { $gte: weekAgo } } }, { $group: { _id: '$outcome', n: { $sum: 1 } } }])
    .toArray();
  return {
    date: now.toISOString().slice(0, 10),
    cap,
    judged: scored.length,
    errors,
    flagged,
    waiting: await samples.countDocuments({ judgedAt: { $exists: false } }),
    means,
    flaggedBy,
    thumbs: { up: votes.find((v) => v._id === 'up')?.n ?? 0, down: votes.find((v) => v._id === 'down')?.n ?? 0 },
    outcomes: Object.fromEntries(outcomes.sort((a, b) => b.n - a.n).map((o) => [o._id, o.n])),
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

export async function listFlagged(connection: Connection = mongoose.connection): Promise<Flagged[]> {
  const samples = await turnSamples(connection)
    .find({ 'flags.0': { $exists: true }, review: { $exists: false } })
    .toArray();
  const votes = await feedbackRecords(connection)
    .find({ rating: 'down', review: { $exists: false } })
    .toArray();
  const fromSamples = samples.map((s: TurnSample & { _id: unknown }) => ({
    id: `s:${String(s._id)}`,
    at: s.createdAt,
    why: `judge: ${(s.flags ?? []).map((f) => `${f} ${s.scores?.[f]?.toFixed(2) ?? '?'}`).join(', ')}`,
    snapshot: s.snapshot,
  }));
  const fromVotes = votes.map((v) => ({
    id: `f:${String(v._id)}`,
    at: v.updatedAt,
    why: `thumbs down${v.reason ? ` (${v.reason})` : ''}${v.comment ? `: "${v.comment}"` : ''}`,
    ...(v.snapshot ? { snapshot: v.snapshot } : {}),
  }));
  return [...fromSamples, ...fromVotes].sort((a, b) => b.at.getTime() - a.at.getTime());
}

/** Closes a flagged turn. It then expires like an unflagged one (30 days from when it happened). */
export async function resolveFlagged(id: string, status: Review['status'], note: string | undefined, connection: Connection = mongoose.connection): Promise<boolean> {
  const [kind, raw] = id.split(':');
  if (!raw || !mongoose.isValidObjectId(raw) || (kind !== 's' && kind !== 'f')) return false;
  const _id = new mongoose.Types.ObjectId(raw);
  const review: Review = { status, at: new Date(), ...(note ? { note } : {}) };
  const collection = kind === 's' ? turnSamples(connection) : feedbackRecords(connection);
  const record = await (collection as ReturnType<typeof turnSamples>).findOne({ _id } as never);
  if (!record) return false;
  await (collection as ReturnType<typeof turnSamples>).updateOne({ _id } as never, { $set: { review, expiresAt: expiresAfter(RETENTION_DAYS.unflagged, record.createdAt) } });
  return true;
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
