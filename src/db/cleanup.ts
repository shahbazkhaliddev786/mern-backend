// The daily sweep of expired records (spec 023): run by Vercel Cron through
// GET /api/v1/internal/cleanup, and by hand with `npm run db:cleanup` (against DATABASE_URL).
// Each kind is deleted in batches, so one run stays short whatever has piled up.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { sql } from 'drizzle-orm';
import { CHECKPOINT_TTL_SECONDS } from '../agent/config.js';
import { getDb, getPool } from './client.js';
import { deleteExpired, EXPIRING_TABLES } from './expiry.js';
import { rateLimits, sessions } from './schema/index.js';

export interface CleanupOptions {
  /** Rows (or conversations) deleted per statement. */
  batch?: number;
  /** Batches per kind, at most: what's left waits for the next run. */
  maxBatches?: number;
}

/** Runs `step` until it deletes less than a full batch, or `maxBatches` times. */
async function drain(step: () => Promise<number>, batch: number, maxBatches: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const deleted = await step();
    total += deleted;
    if (deleted < batch) break;
  }
  return total;
}

/** Login sessions past their expiry (connect-pg-simple stores it as `expire`). */
async function deleteExpiredSessions(limit: number): Promise<number> {
  const result = await getDb().execute(
    sql`delete from ${sessions} where ${sessions.sid} in (select ${sessions.sid} from ${sessions} where ${sessions.expire} < now() limit ${limit})`,
  );
  return result.rowCount ?? 0;
}

/** Rate-limit counters whose window has ended (`expire` is in milliseconds; null never expires). */
async function deleteExpiredRateLimits(limit: number): Promise<number> {
  const now = sql`(extract(epoch from now()) * 1000)::bigint`;
  const result = await getDb().execute(
    sql`delete from ${rateLimits} where ${rateLimits.key} in (select ${rateLimits.key} from ${rateLimits} where ${rateLimits.expire} < ${now} limit ${limit})`,
  );
  return result.rowCount ?? 0;
}

/**
 * Conversations whose newest checkpoint is older than 30 days, as the MongoDB checkpointer's TTL
 * kept them. Each is deleted with the checkpointer's own deleteThread (all three of its tables).
 */
async function deleteIdleConversations(limit: number): Promise<number> {
  const { rows } = await getPool().query<{ thread_id: string }>(
    `SELECT thread_id FROM checkpoints GROUP BY thread_id
      HAVING max((checkpoint->>'ts')::timestamptz) < now() - make_interval(secs => $1) LIMIT $2`,
    [CHECKPOINT_TTL_SECONDS, limit],
  );
  const saver = new PostgresSaver(getPool()); // never `end()` it: the pool is the app's
  for (const { thread_id } of rows) await saver.deleteThread(thread_id);
  return rows.length;
}

/** Deletes every kind of expired record and returns how many of each went. */
export async function cleanupDatabase({ batch = 1000, maxBatches = 50 }: CleanupOptions = {}): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const name of EXPIRING_TABLES) removed[name] = await drain(() => deleteExpired(name, batch), batch, maxBatches);
  removed.session = await drain(() => deleteExpiredSessions(batch), batch, maxBatches);
  removed.rate_limits = await drain(() => deleteExpiredRateLimits(batch), batch, maxBatches);
  removed.conversations = await drain(() => deleteIdleConversations(batch), batch, maxBatches);
  return removed;
}

// `npm run db:cleanup`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { closeDb } = await import('./client.js');
  cleanupDatabase()
    .then((removed) => {
      for (const [kind, count] of Object.entries(removed)) process.stdout.write(`${kind}: ${count}\n`);
      return 0;
    })
    .catch((error: unknown) => {
      process.stderr.write(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    })
    .then(async (code) => {
      await closeDb();
      process.exit(code);
    });
}
