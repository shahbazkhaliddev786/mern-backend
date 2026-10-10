// Per-user budgets for the agent (spec 014, security.md §10). Keyed on the verified user's id,
// never the IP, and on in every environment. Created on first use, so every entry point gets
// them, including Vercel's (follow-ups §14). Tests swap in in-memory limiters.

import mongoose from 'mongoose';
import { RateLimiterMongo, RateLimiterRes, type RateLimiterAbstract } from 'rate-limiter-flexible';
import logger from '../utils/logger.js';

export const AGENT_LIMITS = {
  /** Chat requests, new messages and confirmation answers alike. */
  turnsBurst: { keyPrefix: 'agent_turns_5m', points: 20, duration: 5 * 60 },
  /** The same requests over a day: the cost ceiling per account. */
  turnsDaily: { keyPrefix: 'agent_turns_1d', points: 150, duration: 24 * 60 * 60 },
  /** Write tools that actually run, and avatar uploads. */
  writes: { keyPrefix: 'agent_writes', points: 30, duration: 60 * 60 },
  /** submit_support_request, on top of `writes`: keeps the support inbox usable. */
  support: { keyPrefix: 'agent_support', points: 3, duration: 60 * 60 },
} as const;

export type AgentBudget = keyof typeof AGENT_LIMITS;
export type AgentLimiters = Record<AgentBudget, Pick<RateLimiterAbstract, 'consume'>>;

let limiters: AgentLimiters | null = null;

export function getAgentLimiters(): AgentLimiters {
  if (!limiters) {
    const mongo = (budget: AgentBudget) => new RateLimiterMongo({ storeClient: mongoose.connection, ...AGENT_LIMITS[budget] });
    limiters = { turnsBurst: mongo('turnsBurst'), turnsDaily: mongo('turnsDaily'), writes: mongo('writes'), support: mongo('support') };
  }
  return limiters;
}

/** For tests: in-memory limiters, or null to go back to the MongoDB ones. */
export function setAgentLimiters(replacement: AgentLimiters | null): void {
  limiters = replacement;
}

/** The limit store itself failed (e.g. MongoDB down). Callers refuse rather than let it through. */
export class LimitStoreError extends Error {
  constructor(cause: unknown) {
    super(`Agent limit store failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'LimitStoreError';
  }
}

export type LimitResult = { ok: true } | { ok: false; budget: AgentBudget; msBeforeNext: number };

/**
 * Takes one point from each budget. Refused if any is spent; the longest wait is reported.
 * Throws LimitStoreError when the store fails.
 */
export async function consumeBudgets(userId: string, budgets: AgentBudget[]): Promise<LimitResult> {
  const all = getAgentLimiters();
  const results = await Promise.allSettled(budgets.map((budget) => all[budget].consume(userId)));

  let refused: { budget: AgentBudget; msBeforeNext: number } | null = null;
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') continue;
    if (!(result.reason instanceof RateLimiterRes)) throw new LimitStoreError(result.reason);
    const budget = budgets[i] as AgentBudget;
    if (!refused || result.reason.msBeforeNext > refused.msBeforeNext) refused = { budget, msBeforeNext: result.reason.msBeforeNext };
  }
  if (!refused) return { ok: true };

  // Ids and timing only: no message content.
  logger.warn('AGENT_RATE_LIMITED', { userId, budget: refused.budget, msBeforeNext: refused.msBeforeNext });
  return { ok: false, ...refused };
}

/** "about 4 minutes", "about 1 minute", "about 3 hours" — always rounded up. */
export function waitPhrase(msBeforeNext: number): string {
  const minutes = Math.max(1, Math.ceil(msBeforeNext / 60_000));
  if (minutes < 60) return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
