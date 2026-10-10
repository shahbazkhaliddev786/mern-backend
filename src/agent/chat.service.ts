// Runs one chat turn and yields SSE events (spec 006).

import crypto from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import logger from '../utils/logger.js';
import { claimConfirmation, createCheckpointer } from './checkpointer.js';
import { PROMPT_VERSION, type AgentConfig } from './config.js';
import { buildAgentGraph, createChatModel, createEscalationModel, RECURSION_LIMIT } from './graph.js';
import { consumeBudgets } from './limits.js';
import { toAgentEvents, toolStartEvent, type AgentEvent } from './stream.js';
import { buildToolsForRequest, summarizeConfirmation } from './tools/index.js';

export interface ChatDeps {
  createModel: (config: AgentConfig) => BaseChatModel;
  /** Opus for stuck turns (spec 015). Without it, a stuck turn ends with the support offer. */
  createEscalationModel?: (config: AgentConfig) => BaseChatModel;
  createCheckpointer: () => BaseCheckpointSaver;
  /** Returns false when the confirmation was already claimed by another request. */
  claimConfirmation: (interruptId: string, thread: string) => Promise<boolean>;
}

const defaultDeps: ChatDeps = {
  createModel: (config) => createChatModel(config),
  createEscalationModel: (config) => createEscalationModel(config),
  createCheckpointer: () => createCheckpointer(),
  claimConfirmation: (interruptId, thread) => claimConfirmation(interruptId, thread),
};

export interface ChatTurn {
  config: AgentConfig;
  /** The verified session user (req.user._id). */
  userId: string;
  /** A new customer message; or `resume` to answer a pending confirmation (spec 008). */
  message?: string | undefined;
  resume?: { interruptId: string; approved: boolean } | undefined;
  /** Omit to start a new conversation; required with `resume`. */
  threadId?: string | undefined;
  signal?: AbortSignal;
}

/**
 * Threads are owned: the checkpointer key includes the user id, so a threadId sent by
 * someone else opens their own empty conversation, never another customer's history.
 * The prompt version starts conversations fresh when the prompt or tools change (spec 008).
 */
export const checkpointThreadId = (userId: string, threadId: string) => `${userId}:${threadId}:v${PROMPT_VERSION}`;

const NOTHING_PENDING = "There's nothing waiting for confirmation.";
const ALREADY_CONFIRMED = 'That was already confirmed.';
const CONFIRM_FIRST = 'Please confirm or cancel the pending action first.';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

// Anthropic overload, rate limit and server errors are worth retrying; the rest aren't.
const isRetryable = (error: unknown) => {
  const status = (error as { status?: number }).status;
  return status === 429 || status === 529 || (status !== undefined && status >= 500);
};

// The per-user escalation budget (spec 015). A failed limit store means no escalation.
async function allowEscalation(userId: string): Promise<boolean> {
  try {
    return (await consumeBudgets(userId, ['escalations'])).ok;
  } catch (error) {
    logger.error('AGENT_LIMIT_ERROR', { userId, budget: 'escalations', error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function* runChatTurn(turn: ChatTurn, deps: ChatDeps = defaultDeps): AsyncGenerator<AgentEvent> {
  const threadId = turn.threadId ?? crypto.randomUUID();
  const thread = checkpointThreadId(turn.userId, threadId);
  try {
    const ctx = { userId: turn.userId };
    const tools = buildToolsForRequest(ctx);
    const confirmRequired = new Set(
      tools.filter((t) => (t as { metadata?: { confirmRequired?: boolean } }).metadata?.confirmRequired === true).map((t) => t.name),
    );
    const graph = buildAgentGraph({
      model: deps.createModel(turn.config),
      tools,
      checkpointer: deps.createCheckpointer(),
      userId: turn.userId,
      summarize: (call) => summarizeConfirmation(ctx, call),
      ...(deps.createEscalationModel
        ? { escalation: { model: deps.createEscalationModel(turn.config), allow: () => allowEscalation(turn.userId) } }
        : {}),
    });

    const pending = (await graph.getState({ configurable: { thread_id: thread } })).tasks.flatMap((task) => task.interrupts ?? []);

    let input: Parameters<typeof graph.stream>[0];
    if (turn.resume) {
      // Only a confirmation that is actually pending on this customer's thread can be answered,
      // and only once: the first request to claim it wins (spec 002).
      const waiting = pending.find((i) => i.id === turn.resume?.interruptId);
      if (!waiting) {
        yield { event: 'error', data: { message: NOTHING_PENDING, retryable: false } };
        yield { event: 'done', data: { threadId } };
        return;
      }
      if (!(await deps.claimConfirmation(turn.resume.interruptId, thread))) {
        yield { event: 'error', data: { message: ALREADY_CONFIRMED, retryable: false } };
        yield { event: 'done', data: { threadId } };
        return;
      }
      input = new Command({ resume: { approved: turn.resume.approved } }) as typeof input;
      // The confirmed tool runs now, so this is when its status chip should appear.
      const tool = (waiting.value as { tool?: string } | undefined)?.tool;
      if (turn.resume.approved && tool) yield toolStartEvent(tool);
    } else {
      // A message while a confirmation waits would follow a tool call that has no result yet,
      // which the API rejects; the customer answers the confirmation first (spec 009).
      if (pending.length > 0) {
        yield { event: 'error', data: { message: CONFIRM_FIRST, retryable: false } };
        yield { event: 'done', data: { threadId } };
        return;
      }
      // A new message starts a new turn: the step counter, call record and escalation start again.
      input = { messages: [new HumanMessage(turn.message ?? '')], toolCalls: 0, escalated: false, turnCalls: [] };
    }

    const stream = await graph.stream(
      input,
      {
        configurable: { thread_id: thread },
        streamMode: ['updates', 'messages'],
        recursionLimit: RECURSION_LIMIT,
        ...(turn.signal ? { signal: turn.signal } : {}),
        metadata: { user: hash(turn.userId), threadId },
      },
    );
    for await (const chunk of stream) yield* toAgentEvents(chunk as [string, unknown], { confirmRequired });
  } catch (error) {
    if (turn.signal?.aborted) return; // The customer left; nobody is listening.
    logger.error('AGENT_TURN_FAILED', { userId: turn.userId, threadId, error: error instanceof Error ? error.message : String(error) });
    const retryable = isRetryable(error);
    yield {
      event: 'error',
      data: {
        message: retryable ? 'The assistant is busy right now. Please try again in a moment.' : 'Something went wrong. Please try again.',
        retryable,
      },
    };
  }
  yield { event: 'done', data: { threadId } };
}
