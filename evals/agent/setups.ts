// The two setups spec 020 compares, built in eval code so production is unchanged:
// the cascade (Sonnet 5.5, with Opus 5.5 for stuck turns) and Opus 5.5 alone at low effort.

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatAnthropic } from '@langchain/anthropic';
import { AGENT_MODELS, type AgentConfig } from '../../src/agent/config.js';
import { createChatModel, createEscalationModel } from '../../src/agent/graph.js';

export const SETUP_NAMES = ['cascade', 'opus-only'] as const;
export type SetupName = (typeof SETUP_NAMES)[number];

export interface Setup {
  name: SetupName;
  agent: BaseChatModel;
  /** Without one, a stuck turn ends with the support offer. */
  escalation?: () => BaseChatModel;
  /** The model behind each graph role, for pricing. */
  models: { agent: string; escalation?: string };
}

export function buildSetup(name: SetupName, config: AgentConfig): Setup {
  if (name === 'cascade') {
    return {
      name,
      agent: createChatModel(config),
      escalation: () => createEscalationModel(config),
      models: { agent: AGENT_MODELS.agent, escalation: AGENT_MODELS.escalation },
    };
  }
  // The same settings as production's models (graph.ts), with Opus as the agent at low effort.
  const opus = new ChatAnthropic({
    model: AGENT_MODELS.escalation,
    apiKey: config.anthropicApiKey,
    maxTokens: 8000,
    thinking: { type: 'adaptive' },
    outputConfig: { effort: 'low' },
  });
  return { name, agent: opus, models: { agent: AGENT_MODELS.escalation } };
}

// The cascade by default: it's what customers get, and the comparison doubles the cost.
export function setupsFromEnv(value = process.env.EVAL_SETUP ?? 'cascade'): SetupName[] {
  if (value === 'both') return [...SETUP_NAMES];
  if ((SETUP_NAMES as readonly string[]).includes(value)) return [value as SetupName];
  throw new Error(`EVAL_SETUP must be cascade, opus-only or both (got "${value}")`);
}

export interface JudgePlan {
  name: 'sonnet' | 'opus';
  model: string;
  /** Re-judges turns Opus wrote, against self-grading bias (evals.md §10). */
  crossModel?: string;
  /** Sonnet judging the cascade's own Sonnet turns: fine for a cheap check, not for a verdict. */
  provisional: boolean;
}

/** `EVAL_JUDGE`: Sonnet by default, for cost; Opus for a run whose verdict counts. */
export function judgeFromEnv(value = process.env.EVAL_JUDGE ?? 'sonnet'): JudgePlan {
  if (value === 'sonnet') return { name: 'sonnet', model: AGENT_MODELS.agent, provisional: true };
  if (value === 'opus') return { name: 'opus', model: AGENT_MODELS.escalation, crossModel: AGENT_MODELS.agent, provisional: false };
  throw new Error(`EVAL_JUDGE must be sonnet or opus (got "${value}")`);
}
