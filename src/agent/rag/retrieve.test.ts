import { describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE } from '../config.js';
import { fuseRankings, searchKnowledge, type RetrievalDeps, type SearchHit } from './retrieve.js';

const hit = (id: string): SearchHit => ({ id, title: `T-${id}`, question: `Q-${id}?`, text: `A-${id}.`, context: null });

const deps = (vector: string[], text: string[], scores: Record<string, number>): RetrievalDeps & { rerank: ReturnType<typeof vi.fn> } => ({
  embedQuery: vi.fn(async () => [1, 0]),
  vectorSearch: vi.fn(async () => vector.map(hit)),
  textSearch: vi.fn(async () => text.map(hit)),
  rerank: vi.fn(async (_query: string, documents: string[]) =>
    documents.map((document, index) => ({ index, score: scores[/## Q-(\w+)\?/.exec(document)?.[1] ?? ''] ?? 0 })),
  ),
});

describe('fuseRankings', () => {
  it('ranks hits found by both searches above hits found by one', () => {
    // a: 1/61 + 1/62; c: 1/63 + 1/61; b: 1/62; d: 1/63
    const fused = fuseRankings([[hit('a'), hit('b'), hit('c')], [hit('c'), hit('a'), hit('d')]]);
    expect(fused.map((h) => h.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('keeps at most the candidate limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => hit(`h${i}`));
    expect(fuseRankings([many])).toHaveLength(KNOWLEDGE.candidates);
  });
});

describe('searchKnowledge', () => {
  it('returns the best passages above the cut-off, best first, at most four', async () => {
    const d = deps(['a', 'b', 'c', 'd', 'e', 'f'], ['f', 'a'], { a: 0.9, b: 0.2, c: 0.5, d: 0.6, e: 0.4, f: 0.95 });
    const result = await searchKnowledge('how long is the return window?', d);
    expect(result.found).toBe(true);
    expect(result.passages.map((p) => [p.id, p.score])).toEqual([
      ['f', 0.95],
      ['a', 0.9],
      ['d', 0.6],
      ['c', 0.5],
    ]);
    expect(result.passages[0]).toEqual({ id: 'f', topic: 'T-f', question: 'Q-f?', text: 'A-f.', score: 0.95 });
    expect(d.rerank).toHaveBeenCalledWith('how long is the return window?', expect.any(Array), KNOWLEDGE.topK);
  });

  it('is not found when nothing clears the cut-off', async () => {
    const result = await searchKnowledge('do you sell cars?', deps(['a', 'b'], ['b'], { a: 0.1, b: 0.29 }));
    expect(result).toEqual({ found: false, passages: [] });
  });

  it('is not found, without a rerank call, when the searches return nothing', async () => {
    const d = deps([], [], {});
    expect(await searchKnowledge('anything?', d)).toEqual({ found: false, passages: [] });
    expect(d.rerank).not.toHaveBeenCalled();
  });

  it('reranks the fused candidates with their title and question', async () => {
    const d = deps(['a'], ['a'], { a: 0.8 });
    await searchKnowledge('q', d);
    expect(d.rerank.mock.calls[0]?.[1]).toEqual(['T-a\n## Q-a?\nA-a.']);
  });
});
