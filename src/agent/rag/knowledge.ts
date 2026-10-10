// The app's store-knowledge search (spec 013): the real Atlas searches and Voyage, built on first
// use from the app's MongoDB connection and the agent config.

import mongoose from 'mongoose';
import { getAgentConfig, KNOWLEDGE } from '../config.js';
import type { KnowledgeDoc } from './ingest.js';
import { createRetrievalDeps, searchKnowledge, type KnowledgeResult, type RetrievalDeps } from './retrieve.js';
import { createVoyage } from './voyage.js';

let deps: RetrievalDeps | null = null;

export function askKnowledge(question: string): Promise<KnowledgeResult> {
  if (!deps) {
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database connection for store knowledge');
    deps = createRetrievalDeps(db.collection<KnowledgeDoc>(KNOWLEDGE.collection), createVoyage(getAgentConfig().voyageApiKey));
  }
  return searchKnowledge(question, deps);
}
