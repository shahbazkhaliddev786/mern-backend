import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chunkDocument, chunkKnowledge, readKnowledgeFiles, slugify } from './chunk.js';

const file = (name: string, content: string) => ({ name, content });

describe('chunkKnowledge on the real knowledge files', () => {
  it('gives 27 live chunks and skips the 10 owner TODOs', async () => {
    const { chunks, skipped } = chunkKnowledge(await readKnowledgeFiles());
    expect(chunks).toHaveLength(27);
    expect(skipped).toHaveLength(10);
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(27);
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('TODO(owner)');
      expect(chunk.text).not.toContain('<!--');
      expect(chunk.title).toBeTruthy();
      expect(chunk.id.startsWith(`${chunk.file}#`)).toBe(true);
    }
    expect(chunks.find((chunk) => chunk.id === 'returns.md#how-long-do-i-have-to-return-something')).toMatchObject({
      title: 'Returns and refunds',
      text: 'You can return any product within 30 days.',
    });
  });

  it('every golden points at live chunks, and every live chunk has an answer golden', async () => {
    const { chunks } = chunkKnowledge(await readKnowledgeFiles());
    const { goldens } = JSON.parse(await readFile('evals/knowledge.goldens.json', 'utf8')) as {
      goldens: { kind: string; expectedChunkIds: string[] }[];
    };
    const live = new Set(chunks.map((chunk) => chunk.id));
    const referenced = goldens.flatMap((golden) => golden.expectedChunkIds);
    expect(referenced.filter((id) => !live.has(id))).toEqual([]);
    const answered = new Set(goldens.filter((golden) => golden.kind === 'answer').flatMap((golden) => golden.expectedChunkIds));
    expect([...live].filter((id) => !answered.has(id))).toEqual([]);
    expect(goldens.filter((golden) => golden.kind === 'fallback').every((golden) => golden.expectedChunkIds.length === 0)).toBe(true);
  });
});

describe('chunkKnowledge rules', () => {
  const sample = [
    '# Shipping',
    '',
    '## How much is shipping?',
    '',
    'Free on every order.',
    '',
    '<!-- source: pricing.service.ts -->',
    '',
    '## How long does delivery take?',
    '',
    'TODO(owner): delivery times.',
    '',
    "## Isn't it ever charged?",
    '',
    'Never.',
  ].join('\r\n');

  it('splits on ## headings, strips comments and CRLF, and skips TODO(owner) chunks', () => {
    const { chunks, skipped } = chunkKnowledge([file('shipping.md', sample)]);
    expect(chunks.map((chunk) => [chunk.id, chunk.text])).toEqual([
      ['shipping.md#how-much-is-shipping', 'Free on every order.'],
      ['shipping.md#isnt-it-ever-charged', 'Never.'],
    ]);
    expect(skipped).toEqual(['shipping.md#how-long-does-delivery-take']);
  });

  it('keeps the content hash while the chunk is unchanged, and changes it with the text', () => {
    const [first] = chunkKnowledge([file('shipping.md', sample)]).chunks;
    const [again] = chunkKnowledge([file('shipping.md', sample.replace('<!-- source: pricing.service.ts -->', ''))]).chunks;
    const [edited] = chunkKnowledge([file('shipping.md', sample.replace('Free on every order.', 'Free over $50.'))]).chunks;
    expect(again?.contentHash).toBe(first?.contentHash);
    expect(edited?.contentHash).not.toBe(first?.contentHash);
  });

  it('refuses a file without a title, or the same question twice', () => {
    expect(() => chunkKnowledge([file('x.md', '## Q?\n\nA.')])).toThrow('has no "# " title');
    expect(() => chunkKnowledge([file('x.md', '# X\n\n## Q?\n\nA.\n\n## Q?\n\nB.')])).toThrow('Duplicate question');
  });

  it('slugs drop apostrophes and punctuation', () => {
    expect(slugify("I didn't get my code. What can I do?")).toBe('i-didnt-get-my-code-what-can-i-do');
  });

  it('builds the embedded document from title, context, question and text', () => {
    expect(chunkDocument({ title: 'Shipping', context: 'About cost.', question: 'How much?', text: 'Free.' })).toBe('Shipping\nAbout cost.\n## How much?\nFree.');
    expect(chunkDocument({ title: 'Shipping', context: null, question: 'How much?', text: 'Free.' })).toBe('Shipping\n## How much?\nFree.');
  });
});
