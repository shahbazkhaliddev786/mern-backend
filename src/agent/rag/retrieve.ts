// Store-knowledge retrieval (spec 013): vector and keyword search in parallel, reciprocal-rank
// fusion, Voyage rerank, then a relevance cut-off. Every external call comes in through
// RetrievalDeps, so the pipeline is tested without Voyage or Atlas.

import type { mongo } from 'mongoose';
import { KNOWLEDGE } from '../config.js';
import { chunkDocument } from './chunk.js';
import type { KnowledgeDoc } from './ingest.js';
import type { EmbedFn, RerankFn } from './voyage.js';

export interface SearchHit {
  id: string;
  title: string;
  question: string;
  text: string;
  context?: string | null;
}

export interface Passage {
  id: string;
  /** The file's title, e.g. "Returns and refunds". */
  topic: string;
  question: string;
  text: string;
  /** Rerank relevance, 0–1. */
  score: number;
}

export interface KnowledgeResult {
  found: boolean;
  passages: Passage[];
}

export interface RetrievalDeps {
  embedQuery: (question: string) => Promise<number[]>;
  vectorSearch: (vector: number[], limit: number) => Promise<SearchHit[]>;
  textSearch: (question: string, limit: number) => Promise<SearchHit[]>;
  rerank: RerankFn;
}

// The usual constant for reciprocal-rank fusion: damps the weight of the very top ranks.
const RRF_K = 60;

/** Merges ranked lists: each hit scores the sum of 1 / (k + rank) over the lists it appears in. */
export function fuseRankings(lists: SearchHit[][], limit: number = KNOWLEDGE.candidates): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const entry = scores.get(hit.id) ?? { hit, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      scores.set(hit.id, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.hit);
}

export async function searchKnowledge(question: string, deps: RetrievalDeps): Promise<KnowledgeResult> {
  const [vectorHits, textHits] = await Promise.all([
    deps.embedQuery(question).then((vector) => deps.vectorSearch(vector, KNOWLEDGE.candidates)),
    deps.textSearch(question, KNOWLEDGE.candidates),
  ]);
  const candidates = fuseRankings([vectorHits, textHits]);
  if (candidates.length === 0) return { found: false, passages: [] };

  const ranked = await deps.rerank(question, candidates.map(chunkDocument), KNOWLEDGE.topK);
  const passages = ranked
    .filter((item) => item.score >= KNOWLEDGE.minScore && candidates[item.index])
    .sort((a, b) => b.score - a.score)
    .slice(0, KNOWLEDGE.topK)
    .map((item) => {
      const hit = candidates[item.index] as SearchHit;
      return { id: hit.id, topic: hit.title, question: hit.question, text: hit.text, score: item.score };
    });
  return { found: passages.length > 0, passages };
}

const HIT_PROJECTION = { title: 1, question: 1, text: 1, context: 1 } as const;
const toHit = (doc: KnowledgeDoc | mongo.Document): SearchHit => ({
  id: String(doc._id),
  title: String(doc.title),
  question: String(doc.question),
  text: String(doc.text),
  context: (doc.context as string | null | undefined) ?? null,
});

/** The real searches on Atlas, with Voyage for the query embedding and the rerank. */
export function createRetrievalDeps(collection: mongo.Collection<KnowledgeDoc>, voyage: { embed: EmbedFn; rerank: RerankFn }): RetrievalDeps {
  return {
    embedQuery: async (question) => {
      const [vector] = await voyage.embed([question], 'query');
      if (!vector) throw new Error('Voyage returned no query embedding');
      return vector;
    },
    vectorSearch: async (vector, limit) =>
      (
        await collection
          .aggregate([
            { $vectorSearch: { index: KNOWLEDGE.vectorIndex, path: 'embedding', queryVector: vector, numCandidates: limit * 5, limit } },
            { $project: HIT_PROJECTION },
          ])
          .toArray()
      ).map(toHit),
    textSearch: async (question, limit) =>
      (
        await collection
          .aggregate([
            {
              $search: {
                index: KNOWLEDGE.textIndex,
                compound: {
                  should: [
                    { text: { query: question, path: 'question', score: { boost: { value: 2 } } } },
                    { text: { query: question, path: ['text', 'title', 'context'] } },
                  ],
                },
              },
            },
            { $limit: limit },
            { $project: HIT_PROJECTION },
          ])
          .toArray()
      ).map(toHit),
    rerank: voyage.rerank,
  };
}
