// Store-knowledge retrieval (spec 013): vector and keyword search in parallel, reciprocal-rank
// fusion, Voyage rerank, then a relevance cut-off. Every external call comes in through
// RetrievalDeps, so the pipeline is tested without Voyage or a database. The searches run on
// Postgres (spec 023): pgvector by meaning, full-text search by words.

import { asc, cosineDistance, desc, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../../db/client.js';
import { knowledgeChunks } from '../../db/schema/index.js';
import { KNOWLEDGE } from '../config.js';
import { chunkDocument } from './chunk.js';
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

const hitColumns = {
  id: knowledgeChunks.id,
  title: knowledgeChunks.title,
  question: knowledgeChunks.question,
  text: knowledgeChunks.text,
  context: knowledgeChunks.context,
};

/** The nearest chunks by meaning: cosine distance, the order the HNSW index (vector_cosine_ops) serves. */
export const vectorSearchQuery = (db: Executor, vector: number[], limit: number) =>
  db.select(hitColumns).from(knowledgeChunks).orderBy(cosineDistance(knowledgeChunks.embedding, vector)).limit(limit);

/**
 * The question's English words, any of them, as Atlas's text search matched any word: the words
 * plainto_tsquery finds (stemmed, stop words dropped), joined with OR instead of AND.
 */
const anyWord = (question: string) => sql`replace(plainto_tsquery('english', ${question})::text, '&', '|')::tsquery`;

/**
 * The best chunks by words, from the GIN-indexed `search` column. Title and question weigh most,
 * then the context line, then the answer, as the Atlas search boosted the question.
 */
export const textSearchQuery = (db: Executor, question: string, limit: number) =>
  db
    .select(hitColumns)
    .from(knowledgeChunks)
    .where(sql`${knowledgeChunks.search} @@ ${anyWord(question)}`)
    .orderBy(desc(sql`ts_rank_cd(${knowledgeChunks.search}, ${anyWord(question)})`), asc(knowledgeChunks.id))
    .limit(limit);

/** The real searches on Postgres, with Voyage for the query embedding and the rerank. */
export function createRetrievalDeps(voyage: { embed: EmbedFn; rerank: RerankFn }, db?: Executor): RetrievalDeps {
  return {
    embedQuery: async (question) => {
      const [vector] = await voyage.embed([question], 'query');
      if (!vector) throw new Error('Voyage returned no query embedding');
      return vector;
    },
    // Two queries, run side by side by searchKnowledge: the word search while Voyage embeds.
    vectorSearch: (vector, limit) => vectorSearchQuery(db ?? getDb(), vector, limit),
    textSearch: (question, limit) => textSearchQuery(db ?? getDb(), question, limit),
    rerank: voyage.rerank,
  };
}
