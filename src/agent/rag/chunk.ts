// Splits the store-knowledge files into one chunk per question (spec 013, knowledge/README.md).
// Pure: no I/O here, so the rules are unit-tested on the real files and on small samples.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface KnowledgeFile {
  /** File name, e.g. `returns.md`. */
  name: string;
  content: string;
}

export interface KnowledgeChunk {
  /** `<file>#<question slug>`, stable while the question's wording is. */
  id: string;
  file: string;
  /** The file's `#` title, e.g. "Returns and refunds". */
  title: string;
  question: string;
  text: string;
  /** sha256 of title, question and text: unchanged chunks keep their embedding. */
  contentHash: string;
}

export interface ChunkResult {
  chunks: KnowledgeChunk[];
  /** Ids of questions skipped because the owner hasn't answered them yet. */
  skipped: string[];
}

const TODO_MARKER = 'TODO(owner)';

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, '');

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\n\u0000')).digest('hex');

export function chunkKnowledge(files: KnowledgeFile[]): ChunkResult {
  const chunks: KnowledgeChunk[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const content = stripComments(file.content).replace(/\r\n/g, '\n');
    const title = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    if (!title) throw new Error(`${file.name} has no "# " title`);

    // Each "## " heading starts a chunk that runs to the next one.
    const sections = content.split(/^##\s+/m).slice(1);
    for (const section of sections) {
      const [heading = '', ...body] = section.split('\n');
      const question = heading.trim();
      const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const id = `${file.name}#${slugify(question)}`;
      if (!question || !text) continue;
      if (text.includes(TODO_MARKER) || question.includes(TODO_MARKER)) {
        skipped.push(id);
        continue;
      }
      if (chunks.some((chunk) => chunk.id === id)) throw new Error(`Duplicate question in ${file.name}: "${question}"`);
      chunks.push({ id, file: file.name, title, question, text, contentHash: hash(title, question, text) });
    }
  }
  return { chunks, skipped };
}

/** The knowledge folder at the backend's root. Scripts and tests run from there. */
export const KNOWLEDGE_DIR = path.resolve(process.cwd(), 'knowledge');

/** Reads every `*.md` in the folder except its README, sorted by name. */
export async function readKnowledgeFiles(dir: string = KNOWLEDGE_DIR): Promise<KnowledgeFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort();
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(path.join(dir, name), 'utf8') })));
}

/** The text that is embedded and reranked: the chunk with its file title and context line. */
export const chunkDocument = (chunk: Pick<KnowledgeChunk, 'title' | 'question' | 'text'> & { context?: string | null | undefined }): string =>
  [chunk.title, chunk.context, `## ${chunk.question}`, chunk.text].filter(Boolean).join('\n');
