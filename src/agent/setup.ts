// `npm run agent:setup` — prepares a database for the agent (spec 003). Run once per
// environment with that environment's DATABASE_URL; running it again changes nothing.
//   1. checkpointer.setup(): query indexes + 30-day TTL indexes on checkpoints/checkpoint_writes
//   2. confirm_claims: 30-day TTL index on createdAt (the interrupt id is the unique _id)
//   3. knowledge_chunks: the vector and keyword search indexes (spec 013; Atlas only)
//   4. agent_turn_samples / agent_feedback: expiry, one vote per customer and reply (spec 021)

import mongoose from 'mongoose';
import { connectDB } from '../services/db.service.js';
import { createCheckpointer, CONFIRM_CLAIMS_COLLECTION } from './checkpointer.js';
import { CHECKPOINT_TTL_SECONDS, KNOWLEDGE } from './config.js';
import { ensureOnlineEvalIndexes, FEEDBACK_COLLECTION, TURN_SAMPLES_COLLECTION } from './online-evals.js';
import { ensureKnowledgeIndexes } from './rag/indexes.js';

// Operator output for a one-off command, so stdout rather than the app logger.
const print = (line: string) => process.stdout.write(`${line}\n`);

async function main() {
  const connection = await connectDB();
  const db = connection.db;
  if (!db) throw new Error('No database handle after connectDB()');

  await createCheckpointer(connection).setup();
  await db.collection(CONFIRM_CLAIMS_COLLECTION).createIndex({ createdAt: 1 }, { expireAfterSeconds: CHECKPOINT_TTL_SECONDS });
  await ensureOnlineEvalIndexes(connection);

  print(`Agent setup on database "${db.databaseName}":`);
  for (const name of ['checkpoints', 'checkpoint_writes', CONFIRM_CLAIMS_COLLECTION, TURN_SAMPLES_COLLECTION, FEEDBACK_COLLECTION]) {
    const indexes = await db.collection(name).indexes();
    const described = indexes.map((index) => `${JSON.stringify(index.key)}${index.expireAfterSeconds === undefined ? '' : ` ttl=${index.expireAfterSeconds}s`}`);
    print(`  ${name}: ${described.join(', ')}`);
  }

  // Plain MongoDB has no search indexes. Production is on Atlas; local dev can use Atlas local.
  try {
    const created = await ensureKnowledgeIndexes(db);
    const names = (await db.collection(KNOWLEDGE.collection).listSearchIndexes().toArray()).map((index) => String(index.name));
    print(`  ${KNOWLEDGE.collection}: search indexes ${names.join(', ')}${created.length ? ` (created ${created.join(', ')}; Atlas builds them in the background)` : ''}`);
  } catch (error) {
    print(`  ${KNOWLEDGE.collection}: search indexes not created — this database isn't Atlas (${error instanceof Error ? error.message : String(error)})`);
  }
}

// Exit explicitly: the app logger's MongoDB transport keeps its own connection open,
// which would otherwise hold the process forever.
main()
  .then(() => 0)
  .catch((error: unknown) => {
    process.stderr.write(`Agent setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  })
  .then(async (code) => {
    await mongoose.disconnect();
    process.exit(code);
  });
