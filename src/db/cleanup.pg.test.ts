// Expiry on Postgres (spec 023): records that expired by TTL on MongoDB still expire. The daily
// sweep deletes every kind, in batches; a write deletes a few of its table's expired rows.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from './client';
import { cleanupDatabase } from './cleanup';
import { deleteExpired } from './expiry';
import {
  agentConfirmClaims,
  agentFeedback,
  agentTurnSamples,
  otps,
  pendingCheckouts,
  pendingUploads,
  rateLimits,
  sessions,
  users,
} from './schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from './test-db';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

vi.mock('../utils/email.js', () => ({ sendOTPEmail: async () => {} }));
vi.mock('../utils/cloudinary.js', () => ({ default: {} }));

const DAY = 24 * 60 * 60 * 1000;
const past = () => new Date(Date.now() - DAY);
const future = () => new Date(Date.now() + DAY);
const snapshot = { message: 'hi', calls: [], reply: 'hello' };
const address = { fullName: 'Jane', address: '1 Lane', city: 'Lahore', postalCode: '54000', country: 'PK' };

describe.skipIf(!TEST_DATABASE_URL)('expiry on Postgres', () => {
  let testDb: TestDatabase;
  let userId = '';

  /** A conversation whose only checkpoint is dated `ts`, with a stored channel value and a pending write. */
  const conversation = async (threadId: string, ts: Date) => {
    const saver = new PostgresSaver(getPool());
    const checkpoint = { ...emptyCheckpoint(), ts: ts.toISOString(), channel_values: { messages: ['hi'] }, channel_versions: { messages: 1 } };
    const saved = await saver.put({ configurable: { thread_id: threadId, checkpoint_ns: '' } }, checkpoint as never, { source: 'input', step: -1, parents: {} } as never, { messages: 1 });
    await saver.putWrites(saved, [['messages', 'pending']], 'task-1');
  };
  const rowsOf = async (table: string, threadId: string) =>
    (await getPool().query(`SELECT count(*)::int AS n FROM ${table} WHERE thread_id = $1`, [threadId])).rows[0].n as number;

  beforeAll(async () => {
    testDb = await createTestDatabase('cleanup');
    userId = (await getDb().insert(users).values({ name: 'Jane', email: 'jane.cleanup@example.com', password: 'hash' }).returning())[0]!.id;
  }, 60_000);

  beforeEach(async () => {
    for (const table of [otps, pendingCheckouts, pendingUploads, agentConfirmClaims, agentFeedback, agentTurnSamples, sessions, rateLimits]) await getDb().delete(table);
    await getPool().query('TRUNCATE checkpoints, checkpoint_blobs, checkpoint_writes');
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  it('the daily sweep deletes every kind of expired record and keeps the live ones', async () => {
    const db = getDb();
    for (const [label, expiresAt] of [
      ['old', past()],
      ['new', future()],
    ] as const) {
      await db.insert(otps).values({ email: `${label}@example.com`, otp: '123456', expiresAt });
      await db.insert(pendingCheckouts).values({ stripeSessionId: `cs_${label}`, userId, items: [], shippingAddress: address, subtotal: 1, total: 1, expiresAt });
      await db.insert(pendingUploads).values({ userId, kind: 'avatar', data: Buffer.from('x'), mimeType: 'image/png', size: 1, originalName: `${label}.png`, expiresAt });
      await db.insert(agentConfirmClaims).values({ interruptId: `int-${label}`, thread: 't', expiresAt });
      await db.insert(agentFeedback).values({ userId: 'u1', threadId: 't', replyId: `r-${label}`, rating: 'up', expiresAt });
      await db.insert(agentTurnSamples).values({ user: 'h', threadId: 't', replyId: `r-${label}`, promptVersion: 7, outcome: 'answered', escalated: false, snapshot, expiresAt });
      await db.insert(sessions).values({ sid: `sid-${label}`, sess: { cookie: {} }, expire: expiresAt });
      await db.insert(rateLimits).values({ key: `rl:${label}`, points: 1, expire: expiresAt.getTime() });
    }
    await db.insert(rateLimits).values({ key: 'rl:forever', points: 1, expire: null });
    await conversation('old-thread', new Date(Date.now() - 31 * DAY));
    await conversation('new-thread', new Date(Date.now() - 29 * DAY));

    expect(await cleanupDatabase()).toEqual({
      otps: 1,
      pending_checkouts: 1,
      pending_uploads: 1,
      agent_confirm_claims: 1,
      agent_feedback: 1,
      agent_turn_samples: 1,
      session: 1,
      rate_limits: 1,
      conversations: 1,
    });

    expect((await db.select({ email: otps.email }).from(otps)).map((r) => r.email)).toEqual(['new@example.com']);
    expect((await db.select({ sid: sessions.sid }).from(sessions)).map((r) => r.sid)).toEqual(['sid-new']);
    expect((await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key).sort()).toEqual(['rl:forever', 'rl:new']);
    for (const table of ['checkpoints', 'checkpoint_blobs', 'checkpoint_writes']) {
      expect(await rowsOf(table, 'old-thread')).toBe(0);
      expect(await rowsOf(table, 'new-thread')).toBe(1);
    }
    // A second run finds nothing more.
    expect(Object.values(await cleanupDatabase()).every((n) => n === 0)).toBe(true);
  });

  it('deletes in batches, so one run stays short', async () => {
    for (let i = 0; i < 5; i++) await getDb().insert(otps).values({ email: `stale${i}@example.com`, otp: '1', expiresAt: past() });

    expect(await deleteExpired('otps', 2)).toBe(2);
    expect((await cleanupDatabase({ batch: 2, maxBatches: 1 })).otps).toBe(2);
    expect((await cleanupDatabase({ batch: 2, maxBatches: 5 })).otps).toBe(1);
  });

  it('a write deletes some of its table\'s expired rows as it goes', async () => {
    const { sendOTP } = await import('../services/auth.service');
    await getDb().insert(otps).values({ email: 'stale@example.com', otp: '1', expiresAt: past() });

    await sendOTP('jane.cleanup@example.com');

    expect((await getDb().select({ email: otps.email }).from(otps)).map((r) => r.email)).toEqual(['jane.cleanup@example.com']);
    expect(await getDb().select().from(otps).where(eq(otps.email, 'stale@example.com'))).toEqual([]);
  });
});
