// The app's store-knowledge search (spec 013): the real Postgres searches (spec 023) and Voyage,
// built on first use from the agent config.

import { getAgentConfig } from '../config.js';
import { createRetrievalDeps, searchKnowledge, type KnowledgeResult, type RetrievalDeps } from './retrieve.js';
import { createVoyage } from './voyage.js';

let deps: RetrievalDeps | null = null;

export function askKnowledge(question: string): Promise<KnowledgeResult> {
  deps ??= createRetrievalDeps(createVoyage(getAgentConfig().voyageApiKey));
  return searchKnowledge(question, deps);
}
