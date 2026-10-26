// The two Voyage calls store knowledge needs (spec 013): embeddings and rerank.
// Everything that uses them takes these functions as parameters, so tests never call Voyage.

import { VoyageAIClient } from 'voyageai';
import { KNOWLEDGE } from '../config.js';

export type EmbedFn = (texts: string[], inputType: 'document' | 'query') => Promise<number[][]>;
export type RerankFn = (query: string, documents: string[], topK: number) => Promise<{ index: number; score: number }[]>;

export function createVoyage(apiKey: string): { embed: EmbedFn; rerank: RerankFn } {
  const client = new VoyageAIClient({ apiKey });
  return {
    embed: async (texts, inputType) => {
      const response = await client.embed({
        input: texts,
        model: KNOWLEDGE.embedModel,
        inputType,
        outputDimension: KNOWLEDGE.dimensions,
      });
      const data = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== texts.length || data.some((item) => !item.embedding)) throw new Error('Voyage returned an incomplete embedding response');
      return data.map((item) => item.embedding as number[]);
    },
    rerank: async (query, documents, topK) => {
      if (documents.length === 0) return [];
      const response = await client.rerank({ query, documents, model: KNOWLEDGE.rerankModel, topK });
      return (response.data ?? []).map((item) => ({ index: item.index ?? -1, score: item.relevanceScore ?? 0 })).filter((item) => item.index >= 0);
    },
  };
}
