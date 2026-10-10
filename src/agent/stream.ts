// Graph output → the SSE events of phases.md §2 (spec 006). Reads
// graph.stream(..., { streamMode: ['updates', 'messages'] }) chunks.

import type { BaseMessage } from '@langchain/core/messages';

export type AgentEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'tool_start'; data: { tool: string; label: string } }
  | { event: 'tool_end'; data: { tool: string; ok: boolean } }
  | { event: 'confirm_required'; data: { interruptId: string; tool: string; summary: string } }
  | { event: 'error'; data: { message: string; retryable: boolean } }
  | { event: 'done'; data: { threadId: string } };

export const TOOL_LABELS: Record<string, string> = {
  search_products: 'Searching products…',
  get_product_details: 'Looking at the product…',
  ask_store_knowledge: 'Checking store policies…',
  view_cart: 'Checking your cart…',
  view_orders: 'Looking up your orders…',
  get_order_status: 'Checking that order…',
  view_profile: 'Looking at your profile…',
  add_to_cart: 'Adding to your cart…',
  update_cart_item: 'Updating your cart…',
  clear_cart: 'Clearing your cart…',
  place_order: 'Starting checkout…',
  update_profile: 'Updating your profile…',
  submit_support_request: 'Sending your message to support…',
  upload_avatar: 'Updating your profile picture…',
};

// Nodes whose messages are the assistant speaking to the customer.
const SPEAKING_NODES = new Set(['agent', 'budget_exceeded']);

type StreamChunk = [mode: string, payload: unknown];

/** Text the customer should see: text blocks only, never thinking or tool-input blocks. */
export function visibleText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block && typeof block === 'object' && block.type === 'text' && 'text' in block ? String(block.text) : ''))
    .join('');
}

export const isToolError = (content: BaseMessage['content']) => {
  try {
    const parsed = JSON.parse(visibleText(content)) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && 'error' in parsed);
  } catch {
    return false;
  }
};

export interface StreamOptions {
  /** Confirm-required tools get no tool_start until the customer confirms (spec 008). */
  confirmRequired?: ReadonlySet<string>;
}

export const toolStartEvent = (tool: string): AgentEvent => ({ event: 'tool_start', data: { tool, label: TOOL_LABELS[tool] ?? 'Working on it…' } });

export function* toAgentEvents([mode, payload]: StreamChunk, options: StreamOptions = {}): Generator<AgentEvent> {
  if (mode === 'messages') {
    const [message, metadata] = payload as [BaseMessage, { langgraph_node?: string }];
    if (!SPEAKING_NODES.has(metadata?.langgraph_node ?? '')) return;
    if (message.getType() !== 'ai') return;
    const text = visibleText(message.content);
    if (text) yield { event: 'token', data: { text } };
    return;
  }

  if (mode !== 'updates') return;
  const update = payload as Record<string, { messages?: BaseMessage[] } | unknown[] | undefined>;

  const interrupts = update.__interrupt__;
  if (Array.isArray(interrupts)) {
    for (const pending of interrupts as { id?: string; value?: { tool?: string; summary?: string } }[]) {
      yield { event: 'confirm_required', data: { interruptId: pending.id ?? '', tool: pending.value?.tool ?? '', summary: pending.value?.summary ?? '' } };
    }
  }

  const agentUpdate = update.agent as { messages?: BaseMessage[] } | undefined;
  for (const message of agentUpdate?.messages ?? []) {
    for (const call of (message as { tool_calls?: { name: string }[] }).tool_calls ?? []) {
      if (!options.confirmRequired?.has(call.name)) yield toolStartEvent(call.name);
    }
  }

  const toolsUpdate = update.tools as { messages?: BaseMessage[] } | undefined;
  for (const message of toolsUpdate?.messages ?? []) {
    yield { event: 'tool_end', data: { tool: message.name ?? '', ok: !isToolError(message.content) } };
  }
}

export const formatSse = ({ event, data }: AgentEvent): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
