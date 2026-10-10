// The agent graph (specs 006, 008):  START → agent → [gate →] tools → agent → … → END
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
import { REFUSAL_REPLY, STEP_BUDGET_REPLY, SYSTEM_PROMPT } from './prompt.js';
import { isToolError } from './stream.js';

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // Tool calls made in the current turn; the chat service resets it with each new message.
  toolCalls: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }),
});
type State = typeof AgentState.State;

// Spec 001: thinking and effort set explicitly; thinking text isn't shown to customers.
// clientOptions is for tests that capture the outgoing request.
export function createChatModel(config: AgentConfig, clientOptions?: ChatAnthropicInput['clientOptions']): ChatAnthropic {
  return new ChatAnthropic({
    model: AGENT_MODELS.agent,
    apiKey: config.anthropicApiKey,
    maxTokens: 8000,
    thinking: { type: 'adaptive' },
    outputConfig: { effort: AGENT_EFFORT.agent },
    ...(clientOptions ? { clientOptions } : {}),
  });
}

// The system prompt is a cached block, sent first on every call and never stored in state.
const systemMessage = new SystemMessage({ content: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] });

const pendingToolCalls = (message: BaseMessage | undefined) =>
  message instanceof AIMessage || (message && 'tool_calls' in message) ? ((message as AIMessage).tool_calls ?? []) : [];

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };

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
}

const answer = (call: ToolCall, error: string) =>
  new ToolMessage({ tool_call_id: call.id ?? '', name: call.name, content: JSON.stringify({ error }) });

const threadOf = (config: LangGraphRunnableConfig) => String(config.configurable?.thread_id ?? '');

export function buildAgentGraph({ model, tools, checkpointer, userId, summarize }: AgentGraphDeps) {
  if (!model.bindTools) throw new Error('The agent model must support tool calling');
  // Spec 001: strict tools, tool_choice never set (Sonnet 5.5 rejects forced tool use).
  // `strict` is a ChatAnthropic option the generic BaseChatModel type doesn't list.
  const modelWithTools = model.bindTools(tools, { strict: true } as Parameters<NonNullable<BaseChatModel['bindTools']>>[1]);
  const toolNode = new ToolNode(tools);
  // Read from each tool's metadata (spec 008), so the graph doesn't depend on the tools module.
  const metadataOf = (name: string) =>
    (tools.find((t) => t.name === name) as { metadata?: { kind?: string; confirmRequired?: boolean } } | undefined)?.metadata;
  const needsConfirmation = (call: ToolCall) => metadataOf(call.name)?.confirmRequired === true;

  const agent = async (state: State) => {
    const response = await modelWithTools.invoke([systemMessage, ...state.messages]);
    const meta = response.response_metadata as { stop_reason?: string; stop_details?: { category?: string | null } } | undefined;
    if (meta?.stop_reason === 'refusal') {
      logger.warn('AGENT_REFUSAL', { userId, category: meta.stop_details?.category ?? null });
      return { messages: [new AIMessage(REFUSAL_REPLY)] };
    }
    return { messages: [response] };
  };

  const runTools = async (state: State, config: LangGraphRunnableConfig) => {
    const calls = pendingToolCalls(state.messages.at(-1)) as ToolCall[];
    const result = (await toolNode.invoke(state)) as { messages: BaseMessage[] };
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
    return { messages: result.messages, toolCalls: state.toolCalls + calls.length };
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
    const summary = summarize ? await summarize(call) : `Go ahead with ${call.name}?`;
    const decision = interrupt<ConfirmRequest, ConfirmDecision>({ tool: call.name, args: call.args, summary });
    const approved = decision?.approved === true;
    logger.info('AGENT_CONFIRMATION', { userId, thread: threadOf(config), tool: call.name, toolCallId: call.id, decision: approved ? 'approved' : 'declined' });
    if (approved) return new Command({ goto: 'tools' });
    return new Command({ goto: 'agent', update: { messages: calls.map((c) => answer(c, 'Not run: the customer declined.')) } });
  };

  // Answer every pending tool call (the API needs a result for each), then stop politely.
  const budgetExceeded = async (state: State) => {
    logger.warn('AGENT_TURN_STOPPED', { userId, reason: 'step_budget', toolCalls: state.toolCalls });
    const skipped = pendingToolCalls(state.messages.at(-1)).map(
      (call) => new ToolMessage({ tool_call_id: call.id ?? '', name: call.name, content: '{"error":"Not run: this turn reached its step limit."}' }),
    );
    return { messages: [...skipped, new AIMessage(STEP_BUDGET_REPLY)] };
  };

  const route = (state: State) => {
    const calls = pendingToolCalls(state.messages.at(-1)) as ToolCall[];
    if (calls.length === 0) return END;
    if (state.toolCalls + calls.length > STEP_BUDGET) return 'budget_exceeded';
    return calls.some(needsConfirmation) ? 'gate' : 'tools';
  };

  return new StateGraph(AgentState)
    .addNode('agent', agent)
    .addNode('gate', gate, { ends: ['tools', 'agent'] })
    .addNode('tools', runTools)
    .addNode('budget_exceeded', budgetExceeded)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', route, ['gate', 'tools', 'budget_exceeded', END])
    .addEdge('tools', 'agent')
    .addEdge('budget_exceeded', END)
    .compile({ checkpointer });
}

// Enough supersteps for STEP_BUDGET tool rounds plus the final answer.
export const RECURSION_LIMIT = STEP_BUDGET * 2 + 6;
