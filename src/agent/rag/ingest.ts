// Loads the store-knowledge files into the knowledge_chunks table (spec 013, spec 023). Run with
// `npm run agent:ingest` after the files change. Running it again with no changes makes no
// Claude or Voyage calls: a chunk whose content hash is unchanged keeps its context and embedding.

import { inArray, sql } from 'drizzle-orm';
import { getDb, type Executor } from '../../db/client.js';
import { knowledgeChunks } from '../../db/schema/index.js';
import { chunkDocument, chunkKnowledge, type KnowledgeChunk, type KnowledgeFile } from './chunk.js';
import type { ContextFn } from './context.js';
import type { EmbedFn } from './voyage.js';

export interface IngestDeps {
  /** The app's database unless given. */
  db?: Executor;
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
// Rows per insert statement: well under Postgres's limit on query parameters.
const WRITE_BATCH = 100;

export async function ingestKnowledge(files: KnowledgeFile[], { db = getDb(), embed, writeContext }: IngestDeps): Promise<IngestReport> {
  const { chunks, skipped } = chunkKnowledge(files);
  const stored = new Map(
    (await db.select({ id: knowledgeChunks.id, contentHash: knowledgeChunks.contentHash }).from(knowledgeChunks)).map((row) => [row.id, row.contentHash]),
  );
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
  const rows = changed.map((chunk: KnowledgeChunk, i) => ({
    id: chunk.id,
    file: chunk.file,
    title: chunk.title,
    question: chunk.question,
    text: chunk.text,
    context: contexts[i] ?? null,
    embedding: embeddings[i] as number[],
    contentHash: chunk.contentHash,
    updatedAt: now,
  }));

  // Gone from the files, or back to TODO(owner): no longer an answer.
  const live = new Set(chunks.map((chunk) => chunk.id));
  const removed = [...stored.keys()].filter((id) => !live.has(id));

  // The knowledge changes all at once or not at all: a failed run leaves the last good version.
  await db.transaction(async (tx) => {
    for (let start = 0; start < rows.length; start += WRITE_BATCH) {
      await tx
        .insert(knowledgeChunks)
        .values(rows.slice(start, start + WRITE_BATCH))
        .onConflictDoUpdate({
          target: knowledgeChunks.id,
          set: {
            file: sql`excluded.file`,
            title: sql`excluded.title`,
            question: sql`excluded.question`,
            text: sql`excluded.text`,
            context: sql`excluded.context`,
            embedding: sql`excluded.embedding`,
            contentHash: sql`excluded.content_hash`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    if (removed.length > 0) await tx.delete(knowledgeChunks).where(inArray(knowledgeChunks.id, removed));
  });

  return {
    added: changed.filter((chunk) => !stored.has(chunk.id)).map((chunk) => chunk.id),
    updated: changed.filter((chunk) => stored.has(chunk.id)).map((chunk) => chunk.id),
    unchanged: chunks.length - changed.length,
    removed,
    skipped,
  };
}
