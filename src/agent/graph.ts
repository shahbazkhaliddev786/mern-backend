// The agent graph (specs 006, 008, 015):  START → agent → [gate →] tools → agent → … → END
// A stuck turn goes to `escalate`, which hands the rest of it to Opus once, or to `give_up`.
// Built per request: the tools close over the verified user's id; their definitions,
// the system prompt and the model settings are the same for everyone.

import { ChatAnthropic, type ChatAnthropicInput } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Annotation, Command, END, interrupt, MessagesAnnotation, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import logger from '../utils/logger.js';
import { AGENT_EFFORT, AGENT_MODELS, STEP_BUDGET, type AgentConfig } from './config.js';
import crypto from 'node:crypto';
import { trace, type Span } from '@opentelemetry/api';
import { raiseAlert } from './alerts.js';
import { findSensitive, redact } from './guard.js';
import { GIVE_UP_REPLY, REFUSAL_REPLY, SENSITIVE_REPLY, SYSTEM_PROMPT } from './prompt.js';
import { HISTORY_ONLY_PREFIX, isToolError, visibleText } from './stream.js';

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // Tool calls made in the current turn; the chat service resets it with each new message.
  toolCalls: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }),
  // Spec 015, also reset with each new message: Opus has taken over this turn, and the calls
  // this turn has run (for loop and repeated-error detection).
  escalated: Annotation<boolean>({ reducer: (_previous, next) => next, default: () => false }),
  turnCalls: Annotation<TurnCall[]>({ reducer: (_previous, next) => next, default: () => [] }),
  // Spec 016: tool-call ids the customer approved at the gate. The tools node runs a
  // confirm-required call only if its id is here — a second check behind the gate.
  confirmedCalls: Annotation<string[]>({ reducer: (_previous, next) => next, default: () => [] }),
  // Spec 017: why this turn escalated, for its trace.
  escalationReason: Annotation<StuckReason | null>({ reducer: (_previous, next) => next, default: () => null }),
});

// Spec 017: the agent's own spans (model calls, tools). A no-op unless tracing is on.
const tracer = trace.getTracer('aljo-agent');

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number; cache_creation?: number };
}

/** Token counts and the prompt-cache hit rate. `input_tokens` already includes cached tokens. */
export function usageOf(message: BaseMessage): Record<string, number> | null {
  const usage = (message as { usage_metadata?: Usage }).usage_metadata;
  if (!usage?.input_tokens) return null;
  const cacheRead = usage.input_token_details?.cache_read ?? 0;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens ?? 0,
    cacheRead,
    cacheCreation: usage.input_token_details?.cache_creation ?? 0,
    cacheHitRate: Number((cacheRead / usage.input_tokens).toFixed(4)),
  };
}

const endSpan = (span: Span, attributes: Record<string, string | number | boolean>) => {
  span.setAttributes(attributes);
  span.end();
};
type State = typeof AgentState.State;

// Spec 001: thinking and effort set explicitly; thinking text isn't shown to customers.
// clientOptions is for tests that capture the outgoing request.
export function createChatModel(config: AgentConfig, clientOptions?: ChatAnthropicInput['clientOptions']): ChatAnthropic {
  return claude('agent', config, clientOptions);
}

/** Opus for stuck turns (spec 015): same settings, more effort. */
export function createEscalationModel(config: AgentConfig, clientOptions?: ChatAnthropicInput['clientOptions']): ChatAnthropic {
  return claude('escalation', config, clientOptions);
}

function claude(role: 'agent' | 'escalation', config: AgentConfig, clientOptions?: ChatAnthropicInput['clientOptions']): ChatAnthropic {
  return new ChatAnthropic({
    model: AGENT_MODELS[role],
    apiKey: config.anthropicApiKey,
    maxTokens: 8000,
    thinking: { type: 'adaptive' },
    outputConfig: { effort: AGENT_EFFORT[role] },
    ...(clientOptions ? { clientOptions } : {}),
  });
}

// The system prompt is a cached block, sent first on every call and never stored in state.
const systemMessage = new SystemMessage({ content: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] });

const pendingToolCalls = (message: BaseMessage | undefined) =>
  message instanceof AIMessage || (message && 'tool_calls' in message) ? ((message as AIMessage).tool_calls ?? []) : [];

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };

/** One call this turn ran: its tool, a key for identical calls, and whether it failed. */
export interface TurnCall {
  key: string;
  tool: string;
  error: boolean;
}

export type StuckReason = 'loop' | 'step_budget' | 'repeated_tool_error';

// The same call made twice may be a reasonable retry; the third identical one is a loop (Gap 4).
const MAX_IDENTICAL_CALLS = 2;

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]))
      : value;
const callKey = (call: ToolCall) => `${call.name}:${JSON.stringify(stable(call.args ?? {}))}`;

/** Why the pending calls shouldn't run, if they shouldn't. */
function stuckBeforeRunning(state: { toolCalls: number; turnCalls: TurnCall[] }, calls: ToolCall[]): StuckReason | null {
  const seen = new Map<string, number>();
  for (const key of [...state.turnCalls.map((c) => c.key), ...calls.map(callKey)]) {
    const count = (seen.get(key) ?? 0) + 1;
    if (count > MAX_IDENTICAL_CALLS) return 'loop';
    seen.set(key, count);
  }
  return state.toolCalls + calls.length > STEP_BUDGET ? 'step_budget' : null;
}

/** True when a tool just failed for the second time in a row this turn. */
function repeatedToolError(turnCalls: TurnCall[], justRan: string[]): boolean {
  return justRan.some((tool) => {
    const runs = turnCalls.filter((c) => c.tool === tool);
    return runs.length >= 2 && runs.at(-1)!.error && runs.at(-2)!.error;
  });
}

/** A tool failure, as opposed to a per-user limit refusal (spec 014), which retrying won't fix. */
const isFailure = (content: BaseMessage['content']) =>
  isToolError(content) && (JSON.parse(visibleText(content)) as { limited?: boolean }).limited !== true;

/** What the gate shows the customer (spec 008); the resume answer is ConfirmDecision. */
export interface ConfirmRequest {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}
export interface ConfirmDecision {
  approved: boolean;
}

export interface AgentGraphDeps {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  checkpointer: BaseCheckpointSaver;
  /** For logs only. */
  userId: string;
  /** The sentence the customer confirms for a confirm-required call. Must only read. */
  summarize?: (call: ToolCall) => Promise<string>;
  /**
   * Opus for stuck turns (spec 015), and the per-user budget check that allows it. Without a
   * model, a stuck turn goes straight to the support offer.
   */
  escalation?: { model: BaseChatModel; allow: () => Promise<boolean> };
}

const answer = (call: ToolCall, error: string) =>
  new ToolMessage({ tool_call_id: call.id ?? '', name: call.name, content: JSON.stringify({ error }) });

const threadOf = (config: LangGraphRunnableConfig) => String(config.configurable?.thread_id ?? '');

export function buildAgentGraph({ model, tools, checkpointer, userId, summarize, escalation }: AgentGraphDeps) {
  // Spec 001: strict tools, tool_choice never set (Sonnet 5.5 and Opus 5.5 reject forced tool use).
  // `strict` is a ChatAnthropic option the generic BaseChatModel type doesn't list.
  const bind = (chat: BaseChatModel) => {
    if (!chat.bindTools) throw new Error('The agent model must support tool calling');
    return chat.bindTools(tools, { strict: true } as Parameters<NonNullable<BaseChatModel['bindTools']>>[1]);
  };
  const modelWithTools = bind(model);
  // Same tools, same prompt, same gate: escalation is a model swap for one turn, not a second agent.
  const escalationWithTools = escalation ? bind(escalation.model) : null;
  const toolNode = new ToolNode(tools);
  // Read from each tool's metadata (spec 008), so the graph doesn't depend on the tools module.
  const metadataOf = (name: string) =>
    (tools.find((t) => t.name === name) as { metadata?: { kind?: string; confirmRequired?: boolean } } | undefined)?.metadata;
  const needsConfirmation = (call: ToolCall) => metadataOf(call.name)?.confirmRequired === true;

  const agent = async (state: State, config: LangGraphRunnableConfig) => {
    const chat = state.escalated && escalationWithTools ? escalationWithTools : modelWithTools;
    const role = state.escalated && escalationWithTools ? 'escalation' : 'agent';
    const response = await tracer.startActiveSpan(`chat ${AGENT_MODELS[role]}`, async (span) => {
      try {
        const message = await chat.invoke([systemMessage, ...state.messages]);
        const usage = usageOf(message);
        if (usage) logger.info('AGENT_MODEL_USAGE', { thread: threadOf(config), model: AGENT_MODELS[role], effort: AGENT_EFFORT[role], ...usage });
        const stopReason = (message.response_metadata as { stop_reason?: string } | undefined)?.stop_reason;
        endSpan(span, {
          'gen_ai.system': 'anthropic',
          'gen_ai.request.model': AGENT_MODELS[role],
          'agent.effort': AGENT_EFFORT[role],
          'agent.tool_calls_requested': pendingToolCalls(message).length,
          ...(stopReason ? { 'gen_ai.response.finish_reason': stopReason } : {}),
          ...(usage
            ? {
                'gen_ai.usage.input_tokens': usage.input,
                'gen_ai.usage.output_tokens': usage.output,
                'agent.cache_read_tokens': usage.cacheRead,
                'agent.cache_creation_tokens': usage.cacheCreation,
                'agent.cache_hit_rate': usage.cacheHitRate,
              }
            : {}),
        });
        return message;
      } catch (error) {
        span.recordException(error as Error);
        span.end();
        throw error;
      }
    });
    const meta = response.response_metadata as { stop_reason?: string; stop_details?: { category?: string | null } } | undefined;
    if (meta?.stop_reason === 'refusal') {
      logger.warn('AGENT_REFUSAL', { userId, category: meta.stop_details?.category ?? null, escalated: state.escalated });
      return { messages: [new AIMessage(REFUSAL_REPLY)] };
    }
    // Spec 016: a reply carrying a card number or credential never enters the history.
    if (findSensitive(visibleText(response.content)).length > 0) {
      void raiseAlert('sensitive_in_model_output', { userId, thread: threadOf(config) });
      // The customer already saw the reply, redacted as it streamed; this replaces it in the
      // history only, so the stream skips it (HISTORY_ONLY_PREFIX).
      return { messages: [new AIMessage({ content: SENSITIVE_REPLY, id: `${HISTORY_ONLY_PREFIX}${crypto.randomUUID()}` })] };
    }
    if (state.escalated && pendingToolCalls(response).length === 0) {
      logger.info('AGENT_ESCALATION_RESOLVED', { userId, thread: threadOf(config), toolCalls: state.toolCalls });
    }
    return { messages: [response] };
  };

  const runTools = async (state: State, config: LangGraphRunnableConfig) => {
    const thread = threadOf(config);
    const last = state.messages.at(-1) as AIMessage;
    const calls = pendingToolCalls(last) as ToolCall[];

    // Spec 016: calls that must not run — a confirm-required call with no recorded approval, or
    // arguments carrying a card number or credential. Each still gets a result.
    const refused = new Map<string, string>();
    for (const call of calls) {
      const context = { userId, thread, tool: call.name, toolCallId: call.id ?? '' };
      if (needsConfirmation(call) && !state.confirmedCalls.includes(call.id ?? '')) {
        refused.set(call.id ?? '', "Not run: it wasn't confirmed.");
        void raiseAlert('unconfirmed_write', context);
      } else if (findSensitive(JSON.stringify(call.args ?? {})).length > 0) {
        refused.set(call.id ?? '', 'Not run: it contained sensitive data.');
        void raiseAlert('sensitive_in_tool_args', context);
      }
    }
    const allowed = calls.filter((call) => !refused.has(call.id ?? ''));
    // One ToolNode run per call, still in parallel, each in its own span (spec 017), so the
    // database queries a tool makes sit under that tool in the trace.
    const runOne = (call: ToolCall) =>
      tracer.startActiveSpan(`tool ${call.name}`, async (span) => {
        try {
          const single = new AIMessage({ content: '', tool_calls: [call], ...(last.id ? { id: last.id } : {}) });
          const { messages } = (await toolNode.invoke({ messages: [...state.messages.slice(0, -1), single] })) as { messages: BaseMessage[] };
          endSpan(span, {
            'gen_ai.tool.name': call.name,
            'gen_ai.tool.call.id': call.id ?? '',
            'agent.tool_ok': !messages.some((m) => isToolError(m.content)),
            'agent.confirm_required': needsConfirmation(call),
          });
          return messages;
        } catch (error) {
          span.recordException(error as Error);
          span.end();
          throw error;
        }
      });
    const ran = (await Promise.all(allowed.map(runOne))).flat();
    // A result carrying sensitive data is redacted before the model sees it.
    const checked = ran.map((message) => {
      const text = visibleText(message.content);
      if (findSensitive(text).length === 0) return message;
      const tool = message as ToolMessage;
      void raiseAlert('sensitive_in_tool_result', { userId, thread, tool: tool.name ?? '', toolCallId: tool.tool_call_id });
      return new ToolMessage({ tool_call_id: tool.tool_call_id, name: tool.name ?? '', content: redact(text) });
    });
    const byId = new Map(checked.map((message) => [(message as ToolMessage).tool_call_id, message]));
    const result = {
      messages: calls.map((call) => (refused.has(call.id ?? '') ? answer(call, refused.get(call.id ?? '') as string) : (byId.get(call.id ?? '') as BaseMessage))),
    };
    // Audit trail for every write (security.md §11): ids only, no arguments that could hold personal data.
    for (const message of result.messages) {
      const call = calls.find((c) => c.id === (message as ToolMessage).tool_call_id);
      if (!call || metadataOf(call.name)?.kind !== 'write') continue;
      logger.info('AGENT_WRITE', {
        userId,
        thread: threadOf(config),
        tool: call.name,
        toolCallId: call.id,
        confirmRequired: needsConfirmation(call),
        outcome: isToolError(message.content) ? 'error' : 'ok',
      });
    }
    // Refused calls aren't tool failures: Opus couldn't fix them either (spec 015).
    const record: TurnCall[] = result.messages.map((message) => {
      const call = calls.find((c) => c.id === (message as ToolMessage).tool_call_id);
      const id = call?.id ?? '';
      return { key: call ? callKey(call) : '', tool: message.name ?? call?.name ?? '', error: !refused.has(id) && isFailure(message.content) };
    });
    return { messages: result.messages, toolCalls: state.toolCalls + calls.length, turnCalls: [...state.turnCalls, ...record] };
  };

  // The confirmation gate (spec 008, security.md §6). Only reads before interrupt(): on resume
  // this node runs again from the top (spec 002), so a side effect here would happen twice.
  const gate = async (state: State, config: LangGraphRunnableConfig) => {
    const calls = pendingToolCalls(state.messages.at(-1)) as ToolCall[];
    const confirmable = calls.filter(needsConfirmation);
    if (confirmable.length > 1) {
      return new Command({ goto: 'agent', update: { messages: calls.map((call) => answer(call, 'Not run: ask for one of these at a time.')) } });
    }
    const call = confirmable[0]!;
    // Spec 022: other calls in the same batch would run alongside it after the "yes", so the
    // summary could describe a cart that's about to change. The confirmation is asked on its own.
    if (calls.length > 1) {
      const onItsOwn = `Not run: do the other steps first, then ask for ${call.name} on its own.`;
      return new Command({ goto: 'agent', update: { messages: calls.map((c) => answer(c, onItsOwn)) } });
    }
    const summary = summarize ? await summarize(call) : `Go ahead with ${call.name}?`;
    const decision = interrupt<ConfirmRequest, ConfirmDecision>({ tool: call.name, args: call.args, summary });
    const approved = decision?.approved === true;
    logger.info('AGENT_CONFIRMATION', { userId, thread: threadOf(config), tool: call.name, toolCallId: call.id, decision: approved ? 'approved' : 'declined' });
    if (approved) return new Command({ goto: 'tools', update: { confirmedCalls: [...state.confirmedCalls, call.id ?? ''] } });
    return new Command({ goto: 'agent', update: { messages: calls.map((c) => answer(c, 'Not run: the customer declined.')) } });
  };

  // Why this turn is stuck: pending calls that shouldn't run, or a tool that just failed twice.
  const stuckReason = (state: State): StuckReason => {
    const calls = pendingToolCalls(state.messages.at(-1)) as ToolCall[];
    return calls.length > 0 ? (stuckBeforeRunning(state, calls) ?? 'step_budget') : 'repeated_tool_error';
  };

  // Every pending tool call gets a result before the next model call (the API needs one for each).
  const answerPending = (state: State, error: string) => (pendingToolCalls(state.messages.at(-1)) as ToolCall[]).map((call) => answer(call, error));

  // Spec 015: hand the rest of the turn to Opus once, if there is one and the budget allows.
  const escalate = async (state: State, config: LangGraphRunnableConfig) => {
    const reason = stuckReason(state);
    const log = (outcome: 'escalated' | 'over_budget' | 'no_model') =>
      logger.warn('AGENT_ESCALATION', { userId, thread: threadOf(config), reason, outcome });
    if (state.escalated) return new Command({ goto: 'give_up' });
    if (!escalation) {
      log('no_model');
      return new Command({ goto: 'give_up' });
    }
    if (!(await escalation.allow())) {
      log('over_budget');
      return new Command({ goto: 'give_up' });
    }
    log('escalated');
    // Opus continues the turn from the visible history, with a fresh step budget and call record.
    return new Command({
      goto: 'agent',
      update: { messages: answerPending(state, 'Not run: handing this over.'), escalated: true, escalationReason: reason, toolCalls: 0, turnCalls: [] },
    });
  };

  // Stop politely and offer human support.
  const giveUp = async (state: State, config: LangGraphRunnableConfig) => {
    logger.warn('AGENT_TURN_STOPPED', { userId, thread: threadOf(config), reason: stuckReason(state), escalated: state.escalated });
    return { messages: [...answerPending(state, 'Not run: this turn was stopped.'), new AIMessage(GIVE_UP_REPLY)] };
  };

  const route = (state: State) => {
    const calls = pendingToolCalls(state.messages.at(-1)) as ToolCall[];
    if (calls.length === 0) return END;
    if (stuckBeforeRunning(state, calls)) return 'escalate';
    return calls.some(needsConfirmation) ? 'gate' : 'tools';
  };

  // The tool results at the end of the history are the batch that just ran.
  const afterTools = (state: State) => {
    const justRan: string[] = [];
    for (let i = state.messages.length - 1; i >= 0 && state.messages[i] instanceof ToolMessage; i--) justRan.push(state.messages[i]!.name ?? '');
    return repeatedToolError(state.turnCalls, justRan) ? 'escalate' : 'agent';
  };

  return new StateGraph(AgentState)
    .addNode('agent', agent)
    .addNode('gate', gate, { ends: ['tools', 'agent'] })
    .addNode('tools', runTools)
    .addNode('escalate', escalate, { ends: ['agent', 'give_up'] })
    .addNode('give_up', giveUp)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', route, ['gate', 'tools', 'escalate', END])
    .addConditionalEdges('tools', afterTools, ['agent', 'escalate'])
    .addEdge('give_up', END)
    .compile({ checkpointer });
}

// Enough supersteps for STEP_BUDGET tool rounds plus the final answer.
export const RECURSION_LIMIT = STEP_BUDGET * 2 + 6;
