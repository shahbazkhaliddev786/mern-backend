// Online evals without a key (spec 021): one batch with a stub judge against Postgres — only
// unjudged samples, the daily cap, flags below the thresholds, a summary with no customer text —
// and the review queue. Runs only when TEST_DATABASE_URL is set (it's part of `npm test`).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { expiresAfter, saveFeedback, type TurnSnapshot } from '../../src/agent/online-evals';
import { getDb } from '../../src/db/client';
import { agentFeedback, agentTurnSamples } from '../../src/db/schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../src/db/test-db';
import { judgeBatch, listFlagged, renderFlagged, renderSummary, resolveFlagged, type Judge } from './online';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The online eval checks need TEST_DATABASE_URL in CI (spec 021).');

const SECRET = 'Ship to 9 Private Road';
const snapshot = (reply: string, withTools = true): TurnSnapshot => ({
  message: `${SECRET}, find me a mug`,
  calls: withTools ? [{ name: 'search_products', args: '{"query":"mug"}', result: '{"results":[{"name":"Blue Glazed Mug"}]}' }] : [],
  reply,
});
const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-26T12:00:00Z');

async function sample(reply: string, createdAt: Date, extra: Partial<typeof agentTurnSamples.$inferInsert> = {}, withTools = true) {
  await getDb().insert(agentTurnSamples).values({
    user: 'hashed',
    threadId: 't',
    replyId: `r-${reply}`,
    createdAt,
    expiresAt: expiresAfter(30, createdAt),
    promptVersion: 6,
    outcome: 'answered',
    escalated: false,
    snapshot: snapshot(reply, withTools),
    ...extra,
  });
}

/** Scores by reply text: "bad" fails faithfulness, "off" fails relevancy, "boom" throws. */
const stub: Judge = async (snap) => {
  if (snap.reply === 'boom') throw new Error('judge unavailable');
  return {
    relevancy: snap.reply === 'off' ? 0.3 : 0.95,
    toolFit: 0.9,
    ...(snap.calls.length ? { faithfulness: snap.reply === 'bad' ? 0.5 : 1 } : {}),
  };
};

const sampleFor = async (replyId: string) => (await getDb().select().from(agentTurnSamples).where(eq(agentTurnSamples.replyId, replyId)))[0];
const voteFor = async (replyId: string) => (await getDb().select().from(agentFeedback).where(eq(agentFeedback.replyId, replyId)))[0];

describe.skipIf(!TEST_DATABASE_URL)('online evals: the batch and the review queue', () => {
  let testDb: TestDatabase;
  beforeAll(async () => {
    testDb = await createTestDatabase('online_evals');
  }, 60_000);
  afterAll(async () => {
    await testDb?.drop();
  });
  beforeEach(async () => {
    await getDb().delete(agentTurnSamples);
    await getDb().delete(agentFeedback);
  });

  it('judges only unjudged samples, flags low scores and keeps flagged ones longer', async () => {
    const created = new Date(now.getTime() - DAY);
    await sample('good', created);
    await sample('bad', created);
    await sample('off', created, {}, false);
    await sample('old', created, { judgedAt: new Date(now.getTime() - 2 * DAY), scores: { relevancy: 1 }, flags: [] });

    const summary = await judgeBatch({ judge: stub, cap: 200, now });
    expect(summary).toMatchObject({ judged: 3, flagged: 2, errors: 0, waiting: 0, flaggedBy: { faithfulness: 1, relevancy: 1 } });

    const bad = await sampleFor('r-bad');
    expect(bad).toMatchObject({ flags: ['faithfulness'], scores: { faithfulness: 0.5 }, judgedAt: now });
    expect(bad!.expiresAt.getTime() - created.getTime()).toBe(90 * DAY);
    const off = await sampleFor('r-off');
    expect(off!.scores).not.toHaveProperty('faithfulness'); // no tool results, nothing to be faithful to
    const good = await sampleFor('r-good');
    expect(good).toMatchObject({ flags: [] });
    expect(good!.expiresAt.getTime() - created.getTime()).toBe(30 * DAY);
  });

  it('stops at the daily cap, counting what was already judged today', async () => {
    for (const reply of ['a', 'b', 'c', 'd']) await sample(reply, new Date(now.getTime() - DAY));
    await sample('today', new Date(now.getTime() - DAY), { judgedAt: new Date(now.getTime() - 60_000), scores: {}, flags: [] });
    const summary = await judgeBatch({ judge: stub, cap: 3, now });
    expect(summary).toMatchObject({ judged: 2, waiting: 2 });
  });

  it('leaves a sample the judge failed on for the next batch', async () => {
    await sample('boom', new Date(now.getTime() - DAY));
    const summary = await judgeBatch({ judge: stub, cap: 10, now });
    expect(summary).toMatchObject({ judged: 0, errors: 1, waiting: 1 });
  });

  it('summarises scores, thumbs and outcomes with no customer text', async () => {
    // The real clock throughout: votes are stamped with it, and the summary looks back 7 days.
    const today = new Date();
    await sample('bad', new Date(today.getTime() - DAY));
    await saveFeedback({ userId: 'u1', threadId: 't', replyId: 'r1', rating: 'up' });
    await saveFeedback({ userId: 'u2', threadId: 't', replyId: 'r2', rating: 'down', comment: SECRET, snapshot: snapshot('meh') });
    const summary = await judgeBatch({ judge: stub, cap: 10, now: today });
    const text = renderSummary(summary);
    expect(text).toContain('| faithfulness | 0.50 | 0.9 | 1 |');
    expect(text).toContain('Thumbs, last 7 days: 1 up · 1 down');
    expect(text).toContain('Sampled turns by outcome, last 7 days: answered 1');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Blue Glazed Mug');
  });

  it('a repeat vote keeps the review decision; a changed vote reopens it (spec 022)', async () => {
    await saveFeedback({ userId: 'u1', threadId: 't', replyId: 'r1', rating: 'down', snapshot: snapshot('meh') });
    const [flagged] = await listFlagged();
    await resolveFlagged(flagged!.id, 'promoted', undefined);
    await saveFeedback({ userId: 'u1', threadId: 't', replyId: 'r1', rating: 'down', snapshot: snapshot('meh') });
    expect(await voteFor('r1')).toMatchObject({ review: { status: 'promoted' } });
    expect(await listFlagged()).toEqual([]);
    await saveFeedback({ userId: 'u1', threadId: 't', replyId: 'r1', rating: 'up' });
    expect(await voteFor('r1')).toMatchObject({ review: null });
  });

  it('skips expired records, as the TTL indexes removed them, before any cleanup runs (spec 023)', async () => {
    await sample('stale', new Date(now.getTime() - 40 * DAY)); // expired 10 days before the batch
    expect(await judgeBatch({ judge: stub, cap: 10, now })).toMatchObject({ judged: 0, waiting: 0, outcomes: {} });

    await saveFeedback({ userId: 'u1', threadId: 't', replyId: 'r-old', rating: 'down', snapshot: snapshot('meh') });
    await getDb()
      .update(agentFeedback)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await listFlagged()).toEqual([]);
  });

  it('lists flagged turns and thumbs-downs newest first, and resolves one', async () => {
    await sample('bad', new Date(now.getTime() - 2 * DAY), { judgedAt: now, scores: { faithfulness: 0.5 }, flags: ['faithfulness'] });
    await sample('fine', new Date(now.getTime() - 2 * DAY), { judgedAt: now, scores: { faithfulness: 1 }, flags: [] });
    await saveFeedback({ userId: 'u2', threadId: 't', replyId: 'r2', rating: 'down', reason: 'wrong_answer', snapshot: snapshot('meh') });
    await saveFeedback({ userId: 'u3', threadId: 't', replyId: 'r3', rating: 'up' });

    const flagged = await listFlagged();
    expect(flagged.map((f) => f.why)).toEqual(['thumbs down (wrong_answer)', 'judge: faithfulness 0.50']);
    expect(renderFlagged(flagged)).toContain('Assistant: bad');

    expect(await resolveFlagged(flagged[1]!.id, 'promoted', 'golden online-faithfulness-1')).toBe(true);
    expect((await listFlagged()).map((f) => f.id)).toEqual([flagged[0]!.id]);
    const resolved = await sampleFor('r-bad');
    expect(resolved!.review).toMatchObject({ status: 'promoted', note: 'golden online-faithfulness-1' });
    expect(resolved!.expiresAt.getTime() - resolved!.createdAt.getTime()).toBe(30 * DAY);

    expect(await resolveFlagged(flagged[0]!.id, 'dismissed', undefined)).toBe(true);
    expect(await listFlagged()).toEqual([]);
    expect(renderFlagged([])).toBe('Nothing flagged.');
    expect(await resolveFlagged('s:not-an-id', 'dismissed', undefined)).toBe(false);
    expect(await resolveFlagged(`f:${crypto.randomUUID()}`, 'dismissed', undefined)).toBe(false);
  });
});
