// Knowledge ingestion against Postgres (spec 013, spec 023), with Claude and Voyage replaced by
// counting fakes.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { knowledgeChunks } from '../../db/schema/index.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../../db/test-db.js';
import { KNOWLEDGE } from '../config.js';
import { readKnowledgeFiles, type KnowledgeFile } from './chunk.js';
import { ingestKnowledge, type IngestDeps } from './ingest.js';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

/** A stand-in embedding of the right size, telling chunks apart by their document's length. */
const fakeVector = (length: number) => Array.from({ length: KNOWLEDGE.dimensions }, (_, i) => (i === 0 ? length : i === 1 ? 1 : 0));
const stored = async () => (await getDb().select({ n: count() }).from(knowledgeChunks))[0]!.n;
const chunk = async (id: string) => (await getDb().select().from(knowledgeChunks).where(eq(knowledgeChunks.id, id)))[0];

describe.skipIf(!TEST_DATABASE_URL)('ingestKnowledge', () => {
  let testDb: TestDatabase;
  let files: KnowledgeFile[];
  const calls = { context: 0, embedded: 0 };
  let refuseContext = false;

  const deps = (): IngestDeps => ({
    writeContext: async (chunk) => {
      calls.context += 1;
      return refuseContext ? null : `About ${chunk.question}`;
    },
    embed: async (texts) => {
      calls.embedded += texts.length;
      return texts.map((text) => fakeVector(text.length));
    },
  });

  const editFile = (name: string, change: (content: string) => string) =>
    files.map((file) => (file.name === name ? { ...file, content: change(file.content) } : file));

  beforeAll(async () => {
    testDb = await createTestDatabase('knowledge_ingest');
    files = await readKnowledgeFiles();
  }, 60_000);
  afterAll(async () => {
    await testDb?.drop();
  });
  beforeEach(async () => {
    await getDb().delete(knowledgeChunks);
    calls.context = 0;
    calls.embedded = 0;
    refuseContext = false;
  });

  it('adds every live chunk with its context and embedding', async () => {
    const report = await ingestKnowledge(files, deps());
    expect(report).toMatchObject({ updated: [], unchanged: 0, removed: [] });
    expect(report.added).toHaveLength(27);
    expect(report.skipped).toHaveLength(10);
    expect(await stored()).toBe(27);
    const doc = await chunk('shipping.md#how-much-does-shipping-cost');
    expect(doc).toMatchObject({ title: 'Shipping', question: 'How much does shipping cost?', context: 'About How much does shipping cost?' });
    expect(doc?.embedding).toHaveLength(KNOWLEDGE.dimensions);
    expect(doc?.embedding.slice(0, 2)).toEqual([expect.any(Number), 1]);
  });

  it('a second run with no changes makes no Claude or Voyage calls', async () => {
    await ingestKnowledge(files, deps());
    calls.context = 0;
    calls.embedded = 0;
    const report = await ingestKnowledge(files, deps());
    expect(report).toMatchObject({ added: [], updated: [], unchanged: 27, removed: [] });
    expect(calls).toEqual({ context: 0, embedded: 0 });
  });

  it('re-embeds only an edited chunk', async () => {
    await ingestKnowledge(files, deps());
    calls.context = 0;
    calls.embedded = 0;
    const edited = editFile('payments.md', (content) => content.replace('All prices are in US dollars (USD).', 'All prices are in US dollars.'));
    const report = await ingestKnowledge(edited, deps());
    expect(report.updated).toEqual(['payments.md#what-currency-are-your-prices-in']);
    expect(calls).toEqual({ context: 1, embedded: 1 });
    expect((await chunk('payments.md#what-currency-are-your-prices-in'))?.text).toBe('All prices are in US dollars.');
  });

  it('deletes a chunk that left the files or went back to TODO(owner)', async () => {
    await ingestKnowledge(files, deps());
    let edited = editFile('payments.md', (content) => content.replace(/## Can I use a discount code\?[\s\S]*$/, ''));
    edited = edited.map((file) =>
      file.name === 'returns.md' ? { ...file, content: file.content.replace('You can return any product within 30 days.', 'TODO(owner): confirm the window.') } : file,
    );
    const report = await ingestKnowledge(edited, deps());
    expect(report.removed.sort()).toEqual(['payments.md#can-i-use-a-discount-code', 'returns.md#how-long-do-i-have-to-return-something']);
    expect(await stored()).toBe(25);
  });

  it('a run that fails while writing leaves the last good version (spec 023)', async () => {
    await ingestKnowledge(files, deps());
    const edited = editFile('payments.md', (content) => content.replace('All prices are in US dollars (USD).', 'All prices are in US dollars.'));
    const failing = { ...deps(), embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) }; // the wrong size: the insert fails
    const withRemoval = edited.map((file) => (file.name === 'returns.md' ? { ...file, content: file.content.replace('You can return any product within 30 days.', 'TODO(owner): confirm.') } : file));

    await expect(ingestKnowledge(withRemoval, failing)).rejects.toThrow();

    expect(await stored()).toBe(27);
    expect((await chunk('payments.md#what-currency-are-your-prices-in'))?.text).toBe('All prices are in US dollars (USD).');
    expect(await chunk('returns.md#how-long-do-i-have-to-return-something')).toBeDefined();
  });

  it('still ingests when the context line is refused', async () => {
    refuseContext = true;
    const report = await ingestKnowledge(files, deps());
    expect(report.added).toHaveLength(27);
    expect((await getDb().select({ context: knowledgeChunks.context }).from(knowledgeChunks)).every((row) => row.context === null)).toBe(true);
  });
});
