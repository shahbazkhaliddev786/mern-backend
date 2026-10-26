// `npm run agent:ingest` — loads mern-backend/knowledge/ into the knowledge collection (spec 013).
// Run it after `agent:setup`, and again whenever the knowledge files change; unchanged chunks
// cost nothing. `--dry-run` only prints the chunks, with no database, Claude or Voyage calls.

import mongoose from 'mongoose';
import config from '../config/config.js';
import { connectDB } from '../services/db.service.js';
import { getAgentConfig, KNOWLEDGE } from './config.js';
import { chunkKnowledge, readKnowledgeFiles } from './rag/chunk.js';
import { createContextWriter } from './rag/context.js';
import { ingestKnowledge, type KnowledgeDoc } from './rag/ingest.js';
import { createVoyage } from './rag/voyage.js';

// Operator output for a one-off command, so stdout rather than the app logger.
const print = (line: string) => process.stdout.write(`${line}\n`);

async function main() {
  const files = await readKnowledgeFiles();

  if (process.argv.includes('--dry-run')) {
    const { chunks, skipped } = chunkKnowledge(files);
    for (const chunk of chunks) print(`${chunk.id}  (${chunk.text.length} chars)`);
    print(`${chunks.length} chunks; ${skipped.length} skipped (TODO(owner)): ${skipped.join(', ') || 'none'}`);
    return;
  }

  // The keys are needed whether or not the agent is switched on in this environment.
  const { anthropicApiKey, voyageApiKey } = getAgentConfig({ ...config, AGENT_ENABLED: 'true' });
  const connection = await connectDB();
  const db = connection.db;
  if (!db) throw new Error('No database handle after connectDB()');

  const report = await ingestKnowledge(files, {
    collection: db.collection<KnowledgeDoc>(KNOWLEDGE.collection),
    embed: createVoyage(voyageApiKey).embed,
    writeContext: createContextWriter(anthropicApiKey),
  });

  print(`Knowledge on database "${db.databaseName}":`);
  print(`  added: ${report.added.length}, updated: ${report.updated.length}, unchanged: ${report.unchanged}, removed: ${report.removed.length}`);
  for (const id of [...report.added, ...report.updated]) print(`  + ${id}`);
  for (const id of report.removed) print(`  - ${id}`);
  print(`  skipped (TODO(owner)): ${report.skipped.length}`);
}

// Exit explicitly: the app logger's MongoDB transport keeps its own connection open.
main()
  .then(() => 0)
  .catch((error: unknown) => {
    process.stderr.write(`Knowledge ingestion failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  })
  .then(async (code) => {
    await mongoose.disconnect();
    process.exit(code);
  });
