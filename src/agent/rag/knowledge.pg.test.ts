// Store knowledge on Postgres (spec 013, spec 023): pgvector by meaning, full-text search by
// words, their indexes, and fusion. The embedder is a bag-of-words hash, so this checks a lexical
// floor; the real embedder and the rerank are judged by `npm run eval:knowledge`.

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb, getPool } from '../../db/client.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../db/test-db.js';
import { KNOWLEDGE } from '../config.js';
import { readKnowledgeFiles } from './chunk.js';
import { ingestKnowledge } from './ingest.js';
import { createRetrievalDeps, fuseRankings, searchKnowledge, textSearchQuery, vectorSearchQuery, type RetrievalDeps } from './retrieve.js';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

const STOP = new Set(['a', 'an', 'the', 'i', 'my', 'do', 'you', 'your', 'is', 'are', 'can', 'to', 'of', 'in', 'on', 'and', 'or', 'what', 'how', 'it']);
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => !STOP.has(word)) ?? [];

/** A deterministic stand-in for Voyage: hashed word counts, normalised. */
function fakeEmbed(text: string): number[] {
  const vector = new Array<number>(KNOWLEDGE.dimensions).fill(0);
  for (const word of words(text)) {
    let h = 0;
    for (const char of word.slice(0, 5)) h = (h * 31 + char.charCodeAt(0)) % KNOWLEDGE.dimensions;
    vector[h] = (vector[h] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

/** Word overlap between query and document, 0–1, standing in for Voyage rerank. */
const fakeRerank: RetrievalDeps['rerank'] = async (query, documents, topK) => {
  const asked = new Set(words(query));
  return documents
    .map((document, index) => {
      const found = words(document).filter((word) => asked.has(word));
      return { index, score: asked.size ? new Set(found).size / asked.size : 0 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
};

interface Golden {
  id: string;
  kind: 'answer' | 'fallback' | 'follow-up';
  input: string;
  searchQuery?: string;
  expectedChunkIds: string[];
}

/** The plan Postgres picks for one of the searches, with sequential scans ruled out. */
async function explain(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<string> {
  const { sql, params } = query.toSQL();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // With 27 rows a scan of the table wins; this asks whether the index can serve the query at all.
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe.skipIf(!TEST_DATABASE_URL)('store knowledge on pgvector and Postgres full-text search', () => {
  let testDb: TestDatabase;
  let deps: RetrievalDeps;

  beforeAll(async () => {
    testDb = await createTestDatabase('knowledge');
    await ingestKnowledge(await readKnowledgeFiles(), {
      writeContext: async () => null,
      embed: async (texts) => texts.map(fakeEmbed),
    });
    deps = createRetrievalDeps({ embed: async (texts) => texts.map(fakeEmbed), rerank: fakeRerank });
  }, 60_000);

  afterAll(async () => {
    await testDb?.drop();
  });

  it("each search can use the migration's index: HNSW for meaning, GIN for words", async () => {
    expect(await explain(vectorSearchQuery(getDb(), fakeEmbed('shipping'), KNOWLEDGE.candidates))).toContain('knowledge_chunks_embedding_idx');
    expect(await explain(textSearchQuery(getDb(), 'returning products', KNOWLEDGE.candidates))).toContain('knowledge_chunks_search_idx');
  });

  it('keyword search matches any of the words, and none but stop words finds nothing', async () => {
    expect((await deps.textSearch('shipping', 20)).length).toBeGreaterThan(0);
    expect(await deps.textSearch('what is the', 20)).toEqual([]);
  });

  it('keyword search matches word forms (English stemming)', async () => {
    const hits = await deps.textSearch('returning products', 5);
    expect(hits[0]?.id).toBe('returns.md#how-long-do-i-have-to-return-something');
  });

  it('the fused top 5 holds an expected chunk for at least 80% of the goldens', async () => {
    const { goldens } = JSON.parse(await readFile('evals/knowledge.goldens.json', 'utf8')) as { goldens: Golden[] };
    const answerable = goldens.filter((golden) => golden.expectedChunkIds.length > 0);
    const misses: string[] = [];
    for (const golden of answerable) {
      const query = golden.searchQuery ?? golden.input;
      const [vector, text] = await Promise.all([deps.vectorSearch(fakeEmbed(query), KNOWLEDGE.candidates), deps.textSearch(query, KNOWLEDGE.candidates)]);
      const top = fuseRankings([vector, text]).slice(0, 5).map((hit) => hit.id);
      if (!golden.expectedChunkIds.some((id) => top.includes(id))) misses.push(golden.id);
    }
    const rate = 1 - misses.length / answerable.length;
    process.stdout.write(`lexical floor: ${(rate * 100).toFixed(0)}% of ${answerable.length}; misses: ${misses.join(', ') || 'none'}\n`);
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });

  it('runs the whole pipeline on the real searches', async () => {
    const result = await searchKnowledge('Do I have to pay for shipping?', deps);
    expect(result.found).toBe(true);
    expect(result.passages.map((passage) => passage.id)).toContain('shipping.md#how-much-does-shipping-cost');
    expect(result.passages[0]).toMatchObject({ topic: 'Shipping' });
  });
});
