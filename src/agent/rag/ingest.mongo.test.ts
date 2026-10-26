// Knowledge ingestion against MongoDB (spec 013), with Claude and Voyage replaced by counting fakes.
// Runs only when MONGO_URL is set; no search indexes are needed.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { readKnowledgeFiles, type KnowledgeFile } from './chunk.js';
import { ingestKnowledge, type IngestDeps, type KnowledgeDoc } from './ingest.js';

const MONGO_URL = process.env.MONGO_URL;

describe.skipIf(!MONGO_URL)('ingestKnowledge', () => {
  let collection: IngestDeps['collection'];
  let files: KnowledgeFile[];
  const calls = { context: 0, embedded: 0 };
  let refuseContext = false;

  const deps = (): IngestDeps => ({
    collection,
    writeContext: async (chunk) => {
      calls.context += 1;
      return refuseContext ? null : `About ${chunk.question}`;
    },
    embed: async (texts) => {
      calls.embedded += texts.length;
      return texts.map((text) => [text.length, 1, 0]);
    },
  });

  const editFile = (name: string, change: (content: string) => string) =>
    files.map((file) => (file.name === name ? { ...file, content: change(file.content) } : file));

  beforeAll(async () => {
    await mongoose.connect(`${MONGO_URL}/knowledge_ingest_test`);
    await mongoose.connection.dropDatabase();
    collection = mongoose.connection.db!.collection<KnowledgeDoc>('knowledge_chunks');
    files = await readKnowledgeFiles();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await collection.deleteMany({});
    calls.context = 0;
    calls.embedded = 0;
    refuseContext = false;
  });

  it('adds every live chunk with its context and embedding', async () => {
    const report = await ingestKnowledge(files, deps());
    expect(report).toMatchObject({ updated: [], unchanged: 0, removed: [] });
    expect(report.added).toHaveLength(27);
    expect(report.skipped).toHaveLength(10);
    expect(await collection.countDocuments()).toBe(27);
    const doc = await collection.findOne({ _id: 'shipping.md#how-much-does-shipping-cost' });
    expect(doc).toMatchObject({ title: 'Shipping', question: 'How much does shipping cost?', context: 'About How much does shipping cost?' });
    expect(doc?.embedding).toHaveLength(3);
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
    expect((await collection.findOne({ _id: 'payments.md#what-currency-are-your-prices-in' }))?.text).toBe('All prices are in US dollars.');
  });

  it('deletes a chunk that left the files or went back to TODO(owner)', async () => {
    await ingestKnowledge(files, deps());
    let edited = editFile('payments.md', (content) => content.replace(/## Can I use a discount code\?[\s\S]*$/, ''));
    edited = edited.map((file) =>
      file.name === 'returns.md' ? { ...file, content: file.content.replace('You can return any product within 30 days.', 'TODO(owner): confirm the window.') } : file,
    );
    const report = await ingestKnowledge(edited, deps());
    expect(report.removed.sort()).toEqual(['payments.md#can-i-use-a-discount-code', 'returns.md#how-long-do-i-have-to-return-something']);
    expect(await collection.countDocuments()).toBe(25);
  });

  it('still ingests when the context line is refused', async () => {
    refuseContext = true;
    const report = await ingestKnowledge(files, deps());
    expect(report.added).toHaveLength(27);
    expect((await collection.findOne({}))?.context).toBeNull();
  });
});
