// `npm run agent:setup` — the store knowledge's search indexes on Atlas (spec 013), run once per
// environment with that environment's MONGODB_URL; running it again changes nothing. Everything
// else the agent keeps (memory, confirmation claims, limits, online evals) is in Postgres, prepared
// by `npm run db:migrate` (spec 023); the knowledge moves there too in stage 4.

import mongoose from 'mongoose';
import { connectDB } from '../services/db.service.js';
import { KNOWLEDGE } from './config.js';
import { ensureKnowledgeIndexes } from './rag/indexes.js';

// Operator output for a one-off command, so stdout rather than the app logger.
const print = (line: string) => process.stdout.write(`${line}\n`);

async function main() {
  const connection = await connectDB();
  const db = connection.db;
  if (!db) throw new Error('No database handle after connectDB()');

  print(`Agent setup on database "${db.databaseName}":`);

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
