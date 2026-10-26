// Loads the store-knowledge files into the knowledge collection (spec 013). Run with
// `npm run agent:ingest` after the files change. Running it again with no changes makes no
// Claude or Voyage calls: a chunk whose content hash is unchanged keeps its context and embedding.

import type { mongo } from 'mongoose';
import { chunkDocument, chunkKnowledge, type KnowledgeChunk, type KnowledgeFile } from './chunk.js';
import type { ContextFn } from './context.js';
import type { EmbedFn } from './voyage.js';

export interface KnowledgeDoc {
  _id: string;
  file: string;
  title: string;
  question: string;
  text: string;
  /** Haiku's one-line context, or null when it couldn't be written. */
  context: string | null;
  embedding: number[];
  contentHash: string;
  updatedAt: Date;
}

export interface IngestDeps {
  collection: mongo.Collection<KnowledgeDoc>;
  embed: EmbedFn;
  writeContext: ContextFn;
}

export interface IngestReport {
  added: string[];
  updated: string[];
  unchanged: number;
  removed: string[];
  /** Questions waiting on the owner (`TODO(owner)`), never indexed. */
  skipped: string[];
}

// Voyage takes up to 1,000 texts per request; smaller batches keep each request quick.
const EMBED_BATCH = 64;

export async function ingestKnowledge(files: KnowledgeFile[], { collection, embed, writeContext }: IngestDeps): Promise<IngestReport> {
  const { chunks, skipped } = chunkKnowledge(files);
  const stored = new Map((await collection.find({}, { projection: { contentHash: 1 } }).toArray()).map((doc) => [doc._id, doc.contentHash]));
  const changed = chunks.filter((chunk) => stored.get(chunk.id) !== chunk.contentHash);

  const fileText = new Map(files.map((file) => [file.name, file.content]));
  const contexts = await Promise.all(changed.map((chunk) => writeContext(chunk, fileText.get(chunk.file) ?? '')));

  const embeddings: number[][] = [];
  for (let start = 0; start < changed.length; start += EMBED_BATCH) {
    const batch = changed.slice(start, start + EMBED_BATCH);
    const documents = batch.map((chunk, i) => chunkDocument({ ...chunk, context: contexts[start + i] ?? null }));
    embeddings.push(...(await embed(documents, 'document')));
  }

  const now = new Date();
  await Promise.all(
    changed.map((chunk: KnowledgeChunk, i) =>
      collection.replaceOne(
        { _id: chunk.id },
        {
          file: chunk.file,
          title: chunk.title,
          question: chunk.question,
          text: chunk.text,
          context: contexts[i] ?? null,
          embedding: embeddings[i] as number[],
          contentHash: chunk.contentHash,
          updatedAt: now,
        },
        { upsert: true },
      ),
    ),
  );

  // Gone from the files, or back to TODO(owner): no longer an answer.
  const live = new Set(chunks.map((chunk) => chunk.id));
  const removed = [...stored.keys()].filter((id) => !live.has(id));
  if (removed.length > 0) await collection.deleteMany({ _id: { $in: removed } });

  return {
    added: changed.filter((chunk) => !stored.has(chunk.id)).map((chunk) => chunk.id),
    updated: changed.filter((chunk) => stored.has(chunk.id)).map((chunk) => chunk.id),
    unchanged: chunks.length - changed.length,
    removed,
    skipped,
  };
}
