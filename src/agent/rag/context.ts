// The one-line context for each knowledge chunk (contextual retrieval, spec 013). Written by
// Haiku at ingestion, never at query time. A refusal or an error leaves the chunk without one.

import Anthropic from '@anthropic-ai/sdk';
import { AGENT_MODELS } from '../config.js';
import type { KnowledgeChunk } from './chunk.js';

export type ContextFn = (chunk: KnowledgeChunk, fileText: string) => Promise<string | null>;

const INSTRUCTIONS =
  "Write one short sentence that situates the excerpt within Aljo Store's document, to improve search retrieval of the excerpt. " +
  'Name the topic and what the excerpt answers. Reply with the sentence only.';

export function createContextWriter(apiKey: string): ContextFn {
  const client = new Anthropic({ apiKey });
  return async (chunk, fileText) => {
    try {
      const response = await client.messages.create({
        model: AGENT_MODELS.knowledgeContext,
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: `<document>\n${fileText}\n</document>\n\n<excerpt>\n## ${chunk.question}\n${chunk.text}\n</excerpt>\n\n${INSTRUCTIONS}`,
          },
        ],
      });
      if (response.stop_reason === 'refusal') return null;
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return text || null;
    } catch {
      return null;
    }
  };
}
