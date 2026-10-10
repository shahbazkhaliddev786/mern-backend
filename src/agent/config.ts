// Agent settings in one place (spec 003). Models and effort are code constants, not
// environment variables: changing them changes behaviour and must go through evals.
// Secrets and switches come from src/config/config.ts and are checked lazily, so the
// store boots and its tests run without any agent variables.

import config from '../config/config.js';

export const AGENT_MODELS = {
  agent: 'claude-sonnet-5-5',
  escalation: 'claude-opus-5-5',
  // Writes the one-line context for each knowledge chunk at ingestion (spec 013).
  knowledgeContext: 'claude-haiku-5-5',
} as const;

// Starting points, tuned by evals (docs/shopping-agent/tech-stack.md Layer 3).
export const AGENT_EFFORT = {
  agent: 'low',
  escalation: 'medium',
} as const;

// Store-knowledge retrieval (spec 013). Starting points, tuned with the knowledge goldens.
export const KNOWLEDGE = {
  collection: 'knowledge_chunks',
  vectorIndex: 'knowledge_vector',
  textIndex: 'knowledge_text',
  embedModel: 'voyage-3.5',
  dimensions: 1024,
  rerankModel: 'rerank-2.5',
  /** Results taken from each search, and kept after fusion. */
  candidates: 20,
  /** Passages kept after rerank. */
  topK: 4,
  /** Rerank relevance below this isn't an answer. */
  minScore: 0.3,
} as const;

// Tool calls per turn before the turn counts as stuck (reconciliation.md Gap 4).
export const STEP_BUDGET = 8;

// Part of every conversation's checkpoint key (spec 008). Bump it whenever the system prompt or
// the tool list changes: an edited prompt mid-conversation invalidates the thinking blocks
// already in that conversation (tech-stack.md Layer 3), so conversations start fresh instead.
export const PROMPT_VERSION = 6;

// Checkpoints and confirm claims expire after 30 days without activity (spec 002).
export const CHECKPOINT_TTL_SECONDS = 2_592_000;

export interface AgentEnv {
  AGENT_ENABLED: string;
  ANTHROPIC_API_KEY: string;
  VOYAGE_API_KEY: string;
  LANGSMITH_TRACING: string;
  LANGSMITH_API_KEY: string;
  LANGSMITH_PROJECT: string;
}

export interface AgentConfig {
  enabled: boolean;
  anthropicApiKey: string;
  voyageApiKey: string;
  tracing: { enabled: boolean; apiKey: string; project: string };
}

export class AgentConfigError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Agent is enabled but misconfigured. Missing: ${missing.join(', ')}`);
    this.name = 'AgentConfigError';
    this.missing = missing;
  }
}

const isTrue = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

export function getAgentConfig(env: AgentEnv = config): AgentConfig {
  const agentConfig: AgentConfig = {
    enabled: isTrue(env.AGENT_ENABLED),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    voyageApiKey: env.VOYAGE_API_KEY,
    tracing: { enabled: isTrue(env.LANGSMITH_TRACING), apiKey: env.LANGSMITH_API_KEY, project: env.LANGSMITH_PROJECT },
  };
  if (!agentConfig.enabled) return agentConfig;

  const missing: string[] = [];
  if (!agentConfig.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (!agentConfig.voyageApiKey) missing.push('VOYAGE_API_KEY');
  if (agentConfig.tracing.enabled && !agentConfig.tracing.apiKey) missing.push('LANGSMITH_API_KEY');
  if (missing.length > 0) throw new AgentConfigError(missing);
  return agentConfig;
}
