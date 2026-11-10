// Expiry (spec 023). Postgres has no TTL indexes, so records that used one carry an `expires_at`
// and are deleted three ways:
// - every read skips expired rows, so nothing expired is used while it waits;
// - each write to a table deletes a few of its expired rows (`cleanupAfterWrite`);
// - the daily sweep (`cleanupDatabase` in cleanup.ts) deletes the rest.

import { sql } from 'drizzle-orm';
import logger from '../utils/logger.js';
import { describeError, getDb, type Executor } from './client.js';
import { agentConfirmClaims, agentFeedback, agentTurnSamples, otps, pendingCheckouts, pendingUploads } from './schema/index.js';

/** The tables with an `expires_at` column, each with the column that names a row. */
const EXPIRING = {
  otps: { table: otps, key: otps.id, expiresAt: otps.expiresAt },
  pending_checkouts: { table: pendingCheckouts, key: pendingCheckouts.id, expiresAt: pendingCheckouts.expiresAt },
  pending_uploads: { table: pendingUploads, key: pendingUploads.id, expiresAt: pendingUploads.expiresAt },
  agent_confirm_claims: { table: agentConfirmClaims, key: agentConfirmClaims.interruptId, expiresAt: agentConfirmClaims.expiresAt },
  agent_feedback: { table: agentFeedback, key: agentFeedback.id, expiresAt: agentFeedback.expiresAt },
  agent_turn_samples: { table: agentTurnSamples, key: agentTurnSamples.id, expiresAt: agentTurnSamples.expiresAt },
} as const;

export type ExpiringTable = keyof typeof EXPIRING;
export const EXPIRING_TABLES = Object.keys(EXPIRING) as ExpiringTable[];

/** Rows a write deletes at most: enough to keep up, never enough to slow the customer down. */
export const WRITE_CLEANUP_LIMIT = 100;

/** Deletes up to `limit` expired rows of one table (by key: Postgres's DELETE takes no LIMIT). */
export async function deleteExpired(name: ExpiringTable, limit: number, db: Executor = getDb()): Promise<number> {
  const { table, key, expiresAt } = EXPIRING[name];
  const result = await db.execute(sql`delete from ${table} where ${key} in (select ${key} from ${table} where ${expiresAt} < now() limit ${limit})`);
  return result.rowCount ?? 0;
}

/** After a write: a few of the table's expired rows go too. A failure is logged, never thrown. */
export async function cleanupAfterWrite(name: ExpiringTable): Promise<void> {
  try {
    await deleteExpired(name, WRITE_CLEANUP_LIMIT);
  } catch (error) {
    logger.warn('DB_CLEANUP_FAILED', { table: name, error: describeError(error) });
  }
}
