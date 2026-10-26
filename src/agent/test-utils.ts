// Test helpers for the agent (spec 006). Not imported by production code.

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { z } from 'zod';
import { AGENT_LIMITS, type AgentBudget, type AgentLimiters } from './limits.js';

/** Answers with queued messages in order and records what it was sent. */
export class ScriptedChatModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = [];
  readonly bindings: { tools: unknown[]; kwargs: unknown }[] = [];

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(tools: unknown[], kwargs?: unknown) {
    this.bindings.push({ tools, kwargs });
    return this as unknown as ReturnType<NonNullable<BaseChatModel['bindTools']>>;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const message = this.script.shift() ?? new AIMessage('(script ended)');
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}

let callCounter = 0;
/** An assistant message calling one tool. */
export const toolCall = (name: string, args: Record<string, unknown> = {}) =>
  new AIMessage({ content: '', tool_calls: [{ id: `call_${(callCounter += 1)}`, name, args, type: 'tool_call' }] });

/** A stand-in tool that records its calls. Pass metadata to make it a (confirm-required) write. */
export function recordingTool(name: string, result: unknown = { ok: true }, metadata?: { kind: 'read' | 'write'; confirmRequired: boolean }) {
  const runs: unknown[] = [];
  const fake = tool(
    async (args: Record<string, unknown>) => {
      runs.push(args);
      return JSON.stringify(result);
    },
    { name, description: `Test tool ${name}`, schema: z.object({}).passthrough(), ...(metadata ? { metadata } : {}) },
  );
  return { tool: fake, runs };
}

/** In-memory stand-ins for the agent's per-user limiters (spec 014), with optional smaller limits. */
export function memoryLimiters(points: Partial<Record<AgentBudget, number>> = {}): AgentLimiters {
  const memory = (budget: AgentBudget) => new RateLimiterMemory({ ...AGENT_LIMITS[budget], points: points[budget] ?? AGENT_LIMITS[budget].points });
  return {
    turnsBurst: memory('turnsBurst'),
    turnsDaily: memory('turnsDaily'),
    writes: memory('writes'),
    support: memory('support'),
    escalations: memory('escalations'),
    feedback: memory('feedback'),
  };
}
