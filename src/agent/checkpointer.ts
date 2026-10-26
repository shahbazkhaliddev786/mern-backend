// The agent's short-term memory: LangGraph's MongoDB checkpointer on the app's own
// mongoose connection, so a serverless instance keeps one connection pool (spec 002).

import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import mongoose, { type Connection } from 'mongoose';
import { CHECKPOINT_TTL_SECONDS } from './config.js';

// Backs the confirm guard: a resume claims its interrupt id here first (spec 002).
export const CONFIRM_CLAIMS_COLLECTION = 'confirm_claims';

type SaverClient = ConstructorParameters<typeof MongoDBSaver>[0]['client'];

export function createCheckpointer(connection: Connection = mongoose.connection): MongoDBSaver {
  if (connection.readyState !== mongoose.ConnectionStates.connected || !connection.db) {
    throw new Error('createCheckpointer needs an open MongoDB connection; call connectDB() first');
  }
  return new MongoDBSaver({
    // mongoose 9 uses MongoDB driver 7; the checkpointer is typed against driver 6 but
    // works on a driver 7 client (spec 002, check I9).
    client: connection.getClient() as unknown as SaverClient,
    dbName: connection.db.databaseName,
    ttl: CHECKPOINT_TTL_SECONDS,
  });
}

/**
 * Claims a pending confirmation so only one request can resume it (spec 002: without this,
 * two concurrent confirms ran the tool twice). The interrupt id is the unique _id; returns
 * false when it was already claimed. Expires with the TTL index from `npm run agent:setup`.
 */
export async function claimConfirmation(interruptId: string, thread: string, connection: Connection = mongoose.connection): Promise<boolean> {
  if (!connection.db) throw new Error('claimConfirmation needs an open MongoDB connection');
  try {
    await connection.db
      .collection<{ _id: string; thread: string; createdAt: Date }>(CONFIRM_CLAIMS_COLLECTION)
      .insertOne({ _id: interruptId, thread, createdAt: new Date() });
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

/**
 * Gives a claim back when the resumed run failed before the gate step was saved (spec 022), so
 * the confirmation is still pending and the customer can answer it again. Never called once the
 * step completed: a claim that ran its action stays, so the action can't run twice.
 */
export async function releaseConfirmation(interruptId: string, connection: Connection = mongoose.connection): Promise<void> {
  if (!connection.db) throw new Error('releaseConfirmation needs an open MongoDB connection');
  await connection.db.collection<{ _id: string }>(CONFIRM_CLAIMS_COLLECTION).deleteOne({ _id: interruptId });
}
