// The knowledge collection's two Atlas search indexes (spec 013), created by `npm run agent:setup`.
// Atlas only: plain MongoDB has no search indexes, and setup reports that instead of failing.

import type { mongo } from 'mongoose';
import { KNOWLEDGE } from '../config.js';

export const KNOWLEDGE_SEARCH_INDEXES = [
  {
    name: KNOWLEDGE.vectorIndex,
    type: 'vectorSearch',
    definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: KNOWLEDGE.dimensions, similarity: 'cosine' }] },
  },
  {
    name: KNOWLEDGE.textIndex,
    type: 'search',
    definition: {
      mappings: {
        dynamic: false,
        fields: Object.fromEntries(['title', 'question', 'text', 'context'].map((field) => [field, { type: 'string', analyzer: 'lucene.english' }])),
      },
    },
  },
] as const;

/**
 * Creates whichever index is missing; an existing one is left alone (to change a definition,
 * give it a new name). Returns the names it created.
 */
export async function ensureKnowledgeIndexes(db: mongo.Db): Promise<string[]> {
  const existing = await db.listCollections({ name: KNOWLEDGE.collection }).toArray();
  if (existing.length === 0) await db.createCollection(KNOWLEDGE.collection);
  const collection = db.collection(KNOWLEDGE.collection);
  const present = new Set((await collection.listSearchIndexes().toArray()).map((index) => String(index.name)));
  const missing = KNOWLEDGE_SEARCH_INDEXES.filter((index) => !present.has(index.name));
  if (missing.length > 0) await collection.createSearchIndexes(missing.map((index) => ({ ...index, definition: { ...index.definition } })));
  return missing.map((index) => index.name);
}

/** Waits until both indexes answer queries (Atlas builds them in the background). */
export async function waitForKnowledgeIndexes(db: mongo.Db, timeoutMs = 120_000): Promise<void> {
  const collection = db.collection(KNOWLEDGE.collection);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const indexes = (await collection.listSearchIndexes().toArray()) as { name?: string; queryable?: boolean }[];
    const ready = KNOWLEDGE_SEARCH_INDEXES.every((wanted) => indexes.some((index) => index.name === wanted.name && index.queryable === true));
    if (ready) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the knowledge search indexes');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
