// Store knowledge on real Atlas search (spec 013): the indexes, both searches and fusion.
// Runs only when ATLAS_URL points at Atlas or the mongodb/mongodb-atlas-local image, e.g.
//   ATLAS_URL="mongodb://127.0.0.1:27018/?directConnection=true"
// The embedder is a bag-of-words hash, so this checks a lexical floor; the real embedder and
// the rerank are judged by `npm run eval:knowledge`.

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { KNOWLEDGE } from '../config.js';
import { readKnowledgeFiles } from './chunk.js';
import { ensureKnowledgeIndexes, waitForKnowledgeIndexes } from './indexes.js';
import { ingestKnowledge, type KnowledgeDoc } from './ingest.js';
import { createRetrievalDeps, fuseRankings, searchKnowledge, type RetrievalDeps } from './retrieve.js';

const ATLAS_URL = process.env.ATLAS_URL;

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

describe.skipIf(!ATLAS_URL)('store knowledge on Atlas search', () => {
  let db: mongoose.mongo.Db;
  let collection: mongoose.mongo.Collection<KnowledgeDoc>;
  let deps: RetrievalDeps;

  beforeAll(async () => {
    const connection = await mongoose.createConnection(ATLAS_URL as string, { dbName: 'knowledge_atlas_test' }).asPromise();
    db = connection.db!;
    await db.dropDatabase();
    collection = db.collection<KnowledgeDoc>(KNOWLEDGE.collection);
    await ingestKnowledge(await readKnowledgeFiles(), {
      collection,
      writeContext: async () => null,
      embed: async (texts) => texts.map(fakeEmbed),
    });
    deps = createRetrievalDeps(collection, { embed: async (texts) => texts.map(fakeEmbed), rerank: fakeRerank });
  }, 60_000);

  afterAll(async () => {
    await db?.dropDatabase();
    await mongoose.disconnect();
  });

  it('creates both search indexes once, and a second run changes nothing', async () => {
    expect((await ensureKnowledgeIndexes(db)).sort()).toEqual([KNOWLEDGE.textIndex, KNOWLEDGE.vectorIndex]);
    expect(await ensureKnowledgeIndexes(db)).toEqual([]);
    await waitForKnowledgeIndexes(db);
    // The indexes catch up with the documents shortly after they answer queries.
    for (let i = 0; i < 60; i++) {
      const [text, vector] = await Promise.all([deps.textSearch('shipping', 20), deps.vectorSearch(fakeEmbed('shipping'), 20)]);
      if (text.length > 0 && vector.length === 20) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }, 180_000);

  it('keyword search matches word forms (English analyzer)', async () => {
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
