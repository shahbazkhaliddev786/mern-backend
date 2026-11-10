// The agent's short-term memory: LangGraph's Postgres checkpointer on the app's own pool, so a
// serverless instance keeps one pool (spec 002, spec 023). Its tables come from `npm run db:migrate`.

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { getDb, getPool, type Executor } from '../db/client.js';
import { agentConfirmClaims } from '../db/schema/index.js';
import { cleanupAfterWrite } from '../db/expiry.js';

/** A checkpointer for one request. Never call its `end()`: that closes the pool it was given. */
export function createCheckpointer(pool: pg.Pool = getPool()): PostgresSaver {
  return new PostgresSaver(pool);
}

/**
 * Claims a pending confirmation so only one request can resume it (spec 002: without this,
 * two concurrent confirms ran the tool twice). The interrupt id is the primary key; returns
 * false when it was already claimed. Expires with the conversation, after 30 days.
 */
export async function claimConfirmation(interruptId: string, thread: string, db: Executor = getDb()): Promise<boolean> {
  const claimed = await db
    .insert(agentConfirmClaims)
    .values({ interruptId, thread })
    .onConflictDoNothing({ target: agentConfirmClaims.interruptId })
    .returning({ interruptId: agentConfirmClaims.interruptId });
  await cleanupAfterWrite('agent_confirm_claims');
  return claimed.length > 0;
}

/**
 * Gives a claim back when the resumed run failed before the gate step was saved (spec 022), so
 * the confirmation is still pending and the customer can answer it again. Never called once the
 * step completed: a claim that ran its action stays, so the action can't run twice.
 */
export async function releaseConfirmation(interruptId: string, db: Executor = getDb()): Promise<void> {
  await db.delete(agentConfirmClaims).where(eq(agentConfirmClaims.interruptId, interruptId));
}
