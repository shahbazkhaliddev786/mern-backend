import { tool, type DynamicStructuredTool } from '@langchain/core/tools';
import logger from '../../utils/logger.js';
import { consumeBudgets, waitPhrase, type AgentBudget } from '../limits.js';
import { toolResult } from './helpers.js';
import type { ToolContext } from './types.js';

/**
 * Per-user write limits (spec 014). The check runs when the tool runs: after the confirmation
 * gate for confirm-required tools, so a declined action costs nothing. Name, description,
 * schema and metadata are unchanged, so the model and the gate see the same tool.
 */
export function withWriteLimit(original: DynamicStructuredTool, ctx: ToolContext): DynamicStructuredTool {
  const support = original.name === 'submit_support_request';
  const budgets: AgentBudget[] = support ? ['writes', 'support'] : ['writes'];
  return tool(
    async (args: Record<string, unknown>, config) => {
      try {
        const result = await consumeBudgets(ctx.userId, budgets);
        if (!result.ok) {
          const wait = waitPhrase(result.msBeforeNext);
          // `limited` marks a refusal, not a failure: retrying won't help, so it never counts toward escalation (spec 015).
          return toolResult({
            error:
              result.budget === 'support'
                ? `You've sent several messages to support recently. Please wait ${wait}, or use the Contact page (/contact).`
                : `You've made a lot of changes in a short time. Please wait ${wait} and try again.`,
            limited: true,
          });
        }
      } catch (error) {
        logger.error('AGENT_LIMIT_ERROR', { userId: ctx.userId, tool: original.name, error: error instanceof Error ? error.message : String(error) });
        return toolResult({ error: "I can't make changes right now. Please try again in a moment.", limited: true });
      }
      return original.func(args, undefined, config);
    },
    { name: original.name, description: original.description, schema: original.schema, metadata: original.metadata ?? {} },
  ) as unknown as DynamicStructuredTool;
}
