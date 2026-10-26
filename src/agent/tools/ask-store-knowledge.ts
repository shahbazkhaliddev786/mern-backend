import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import logger from '../../utils/logger.js';
import { askKnowledge } from '../rag/knowledge.js';
import { toolError, toolResult } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

// From knowledge/contact-and-support.md. Given whenever the knowledge has no answer.
export const KNOWLEDGE_CONTACT =
  'Aljo Store can be reached from the Contact page (/contact) or at hello@aljostore.com, Monday to Friday, 9am to 6pm EST. ' +
  'You can also offer to send the question to support with submit_support_request.';

export const askStoreKnowledgeTool = (ctx: ToolContext) =>
  tool(
    async ({ question }: { question: string }) => {
      try {
        const result = await askKnowledge(question);
        // Ids and scores only: the question can hold personal details.
        logger.info('AGENT_RETRIEVAL', {
          userId: ctx.userId,
          found: result.found,
          ids: result.passages.map((passage) => passage.id),
          topScore: result.passages[0]?.score ?? null,
        });
        if (!result.found) return toolResult({ found: false, contact: KNOWLEDGE_CONTACT });
        return toolResult({
          found: true,
          passages: result.passages.map(({ topic, question: asked, text }) => ({ topic, question: asked, text })),
        });
      } catch (error) {
        logger.error('AGENT_TOOL_ERROR', { tool: 'ask_store_knowledge', userId: ctx.userId, error: error instanceof Error ? error.message : String(error) });
        return toolError(`I can't look up store policies right now. ${KNOWLEDGE_CONTACT}`);
      }
    },
    {
      name: 'ask_store_knowledge',
      description:
        "Look up Aljo Store's published policies and help: shipping, tax, returns and refunds, payments, ordering, accounts and sign-in, " +
        'contact and support, and the store itself. Pass one self-contained question that resolves anything said earlier in the ' +
        'conversation (for "and for shoes?" after a returns question, pass "What is the return window for shoes?"). ' +
        "Not for the customer's own orders, cart or profile: use the account tools for those.",
      schema: z.object({
        question: z.string().trim().min(3).max(300).describe('A self-contained question, in English.'),
      }),
      metadata: READ_TOOL_METADATA,
    },
  );
