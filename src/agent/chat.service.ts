// Runs one chat turn and yields SSE events (spec 006).

import crypto from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import logger from '../utils/logger.js';
import { createCheckpointer } from './checkpointer.js';
import type { AgentConfig } from './config.js';
import { buildAgentGraph, createChatModel, RECURSION_LIMIT } from './graph.js';
import { toAgentEvents, type AgentEvent } from './stream.js';
import { buildToolsForRequest } from './tools/index.js';

export interface ChatDeps {
  createModel: (config: AgentConfig) => BaseChatModel;
  createCheckpointer: () => BaseCheckpointSaver;
}

const defaultDeps: ChatDeps = { createModel: (config) => createChatModel(config), createCheckpointer: () => createCheckpointer() };

export interface ChatTurn {
  config: AgentConfig;
  /** The verified session user (req.user._id). */
  userId: string;
  message: string;
  /** Omit to start a new conversation. */
  threadId?: string | undefined;
  signal?: AbortSignal;
}

/**
 * Threads are owned: the checkpointer key includes the user id, so a threadId sent by
 * someone else opens their own empty conversation, never another customer's history.
 */
export const checkpointThreadId = (userId: string, threadId: string) => `${userId}:${threadId}`;

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

// Anthropic overload, rate limit and server errors are worth retrying; the rest aren't.
const isRetryable = (error: unknown) => {
  const status = (error as { status?: number }).status;
  return status === 429 || status === 529 || (status !== undefined && status >= 500);
};

export async function* runChatTurn(turn: ChatTurn, deps: ChatDeps = defaultDeps): AsyncGenerator<AgentEvent> {
  const threadId = turn.threadId ?? crypto.randomUUID();
  try {
    const graph = buildAgentGraph({
      model: deps.createModel(turn.config),
      tools: buildToolsForRequest({ userId: turn.userId }),
      checkpointer: deps.createCheckpointer(),
      userId: turn.userId,
    });
    const stream = await graph.stream(
      // A new message starts a new turn, so the step counter starts again.
      { messages: [new HumanMessage(turn.message)], toolCalls: 0 },
      {
        configurable: { thread_id: checkpointThreadId(turn.userId, threadId) },
        streamMode: ['updates', 'messages'],
        recursionLimit: RECURSION_LIMIT,
        ...(turn.signal ? { signal: turn.signal } : {}),
        metadata: { user: hash(turn.userId), threadId },
      },
    );
    for await (const chunk of stream) yield* toAgentEvents(chunk as [string, unknown]);
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
