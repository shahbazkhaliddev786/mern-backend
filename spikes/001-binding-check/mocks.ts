// Messages API response builders for offline mode. Shapes follow the Claude API
// reference; signatures are fake but opaque strings, which is all the binding sees.

import type { MockResponder } from './capture.ts';

type Block = Record<string, unknown>;

interface MockMessage {
  content: Block[];
  stop_reason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens';
  stop_details?: Record<string, unknown> | null;
  usage?: Record<string, number>;
}

const DEFAULT_USAGE = { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function messageJson(model: string, msg: MockMessage) {
  return {
    id: `msg_mock_${Math.random().toString(36).slice(2, 10)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: msg.content,
    stop_reason: msg.stop_reason,
    stop_sequence: null,
    stop_details: msg.stop_details ?? null,
    usage: { ...DEFAULT_USAGE, ...msg.usage },
  };
}

/** Answers with JSON, or with an SSE stream when the request asked for one. */
export function mock(msg: MockMessage): MockResponder {
  return (body) => {
    const model = String(body.model);
    if (body.stream === true) return sseResponse(messageJson(model, msg));
    return new Response(JSON.stringify(messageJson(model, msg)), {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req_mock' },
    });
  };
}

function sseResponse(message: ReturnType<typeof messageJson>): Response {
  const events: [string, unknown][] = [];
  events.push(['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_details: null } }]);
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    } else if (block.type === 'thinking') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } }]);
    } else if (block.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }]);
      events.push([
        'content_block_delta',
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
      ]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details },
      usage: { output_tokens: message.usage.output_tokens },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_mock' } });
}

export const thinkingBlock = (thinking = '', signature = 'sig_mock_EqQBCkgIARABGAIiQ') => ({ type: 'thinking', thinking, signature });
export const textBlock = (text: string) => ({ type: 'text', text });
export const toolUseBlock = (name: string, input: Record<string, unknown>, id = 'toolu_mock_01') => ({ type: 'tool_use', id, name, input });
