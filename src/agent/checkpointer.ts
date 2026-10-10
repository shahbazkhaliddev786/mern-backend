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
