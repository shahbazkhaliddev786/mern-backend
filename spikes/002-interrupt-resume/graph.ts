// Spike graph for spec 002, shaped like the M4 design:
//   START → agent → gate → tools → agent → END
// The agent is scripted (no model), and the tool's only side effect is a document in
// MongoDB, so every check counts executions in the database, never in memory.

import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, END, interrupt, MessagesAnnotation, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { Db } from 'mongodb';

export const CONFIRM_REQUIRED = new Set(['clear_cart', 'place_order', 'cancel_order', 'update_profile', 'upload_avatar', 'submit_support_request']);

export interface ConfirmRequest {
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface ConfirmDecision {
  approved: boolean;
}

const threadOf = (config: LangGraphRunnableConfig) => String(config.configurable?.thread_id);

function lastAi(messages: BaseMessage[]): AIMessage | undefined {
  const last = messages.at(-1);
  return last instanceof AIMessage ? last : undefined;
}

export function buildGraph(db: Db, checkpointer: BaseCheckpointSaver) {
  const agent = async (state: typeof MessagesAnnotation.State) => {
    const last = state.messages.at(-1);
    if (last instanceof ToolMessage) {
      const declined = String(last.content).includes('declined');
      return { messages: [new AIMessage(declined ? 'Okay, I left your cart as it is.' : 'Done — your cart is empty.')] };
    }
    return {
      messages: [new AIMessage({ content: '', tool_calls: [{ id: 'call_clear_1', name: 'clear_cart', args: {}, type: 'tool_call' }] })],
    };
  };

  const gate = async (state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) => {
    // Deliberately a side effect before interrupt(): it makes the node's re-run on resume visible (check I4).
    await db.collection('spike_gate_entries').insertOne({ threadId: threadOf(config), at: new Date() });

    const call = lastAi(state.messages)?.tool_calls?.[0];
    if (!call || !CONFIRM_REQUIRED.has(call.name)) return new Command({ goto: 'tools' });

    const decision = interrupt<ConfirmRequest, ConfirmDecision>({
      tool: call.name,
      args: call.args,
      summary: 'Remove all 2 items from your cart?',
    });
    if (decision?.approved === true) return new Command({ goto: 'tools' });
    return new Command({
      goto: 'agent',
      update: { messages: [new ToolMessage({ tool_call_id: call.id ?? '', content: 'The customer declined. Nothing was changed.' })] },
    });
  };

  const tools = async (state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) => {
    const calls = lastAi(state.messages)?.tool_calls ?? [];
    const results: ToolMessage[] = [];
    for (const call of calls) {
      await db.collection('spike_effects').insertOne({ threadId: threadOf(config), toolCallId: call.id, tool: call.name, at: new Date() });
      results.push(new ToolMessage({ tool_call_id: call.id ?? '', content: 'Cart cleared.' }));
    }
    return { messages: results };
  };

  const afterAgent = (state: typeof MessagesAnnotation.State) => ((lastAi(state.messages)?.tool_calls?.length ?? 0) > 0 ? 'gate' : END);

  return new StateGraph(MessagesAnnotation)
    .addNode('agent', agent)
    .addNode('gate', gate, { ends: ['tools', 'agent'] })
    .addNode('tools', tools)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', afterAgent, ['gate', END])
    .addEdge('tools', 'agent')
    .compile({ checkpointer });
}
