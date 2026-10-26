// Checks C1-C12 from spec 001. Each check runs through ChatAnthropic (the binding
// under test) and, where useful, through @anthropic-ai/sdk directly (the control),
// and asserts on the captured request body, not on what either library claims.

import Anthropic from '@anthropic-ai/sdk';
import { ChatAnthropic } from '@langchain/anthropic';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createCapture, type Capture, type CapturedRequest } from './capture.ts';
import { mock, textBlock, thinkingBlock, toolUseBlock } from './mocks.ts';

export const SONNET = 'claude-sonnet-5-5';
export const HAIKU = 'claude-haiku-5-5';
export const OPUS = 'claude-opus-5-5';

export type Verdict = 'pass' | 'pass-with-note' | 'fail' | 'n/a';

export interface CheckResult {
  id: string;
  name: string;
  binding: Verdict;
  sdk: Verdict;
  evidence: string;
  note?: string;
}

export interface Ctx {
  offline: boolean;
  capture: Capture;
}

const API_KEY = process.env.ANTHROPIC_API_KEY ?? 'offline-placeholder-key';

// ---------------------------------------------------------------------------
// Helpers

function chat(ctx: Ctx, fields: Record<string, unknown> = {}) {
  return new ChatAnthropic({
    model: SONNET,
    maxTokens: 2048,
    apiKey: API_KEY,
    clientOptions: { fetch: ctx.capture.fetch, maxRetries: 0 },
    ...fields,
  } as ConstructorParameters<typeof ChatAnthropic>[0]);
}

function sdk(ctx: Ctx) {
  return new Anthropic({ apiKey: API_KEY, fetch: ctx.capture.fetch, maxRetries: 0 });
}

const last = (ctx: Ctx): CapturedRequest => {
  const req = ctx.capture.requests.at(-1);
  if (!req) throw new Error('no request captured');
  return req;
};

/** Offline: the mock answers. Live: the API answers, except where `always` forces a mock. */
function offlineQueue(ctx: Ctx, ...responders: Parameters<Capture['queue']>) {
  if (ctx.offline) ctx.capture.queue(...responders);
}

const json = (value: unknown) => JSON.stringify(value);
const okStatus = (req: CapturedRequest) => req.status === 200;
const has = (cond: boolean, ok: string, bad: string, problems: string[]) => {
  if (!cond) problems.push(bad);
  return cond ? ok : bad;
};

function verdict(problems: string[], notes: string[] = []): Verdict {
  if (problems.length > 0) return 'fail';
  return notes.length > 0 ? 'pass-with-note' : 'pass';
}

async function attempt(fn: () => Promise<void>, problems: string[]) {
  try {
    await fn();
  } catch (error) {
    problems.push(`threw: ${(error as Error).message.split('\n')[0]}`);
  }
}

const searchProducts = tool(async () => 'ok', {
  name: 'search_products',
  description: 'Search the store catalog.',
  schema: z.object({
    query: z.string().describe('Keywords'),
    price_max: z.number().describe('Maximum price in USD'),
  }),
});

const SEARCH_TOOL_RAW: Anthropic.Tool = {
  name: 'search_products',
  description: 'Search the store catalog.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, price_max: { type: 'number' } },
    required: ['query', 'price_max'],
    additionalProperties: false,
  },
  strict: true,
} as Anthropic.Tool;

const TOOL_PROMPT = 'Use the search_products tool to find running shoes under $50. Call the tool; do not answer from memory.';

// ---------------------------------------------------------------------------
// C1 thinking + effort (Sonnet 5.5)

export async function c1(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  const s: string[] = [];
  let evidence = '';
  await attempt(async () => {
    offlineQueue(ctx, mock({ content: [thinkingBlock(), textBlock('Paris.')], stop_reason: 'end_turn' }));
    await chat(ctx, { thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } }).invoke('Capital of France? One word.');
    const req = last(ctx);
    evidence = `thinking=${json(req.body.thinking)} output_config=${json(req.body.output_config)} status=${req.status}`;
    has(json(req.body.thinking) === json({ type: 'adaptive' }), '', 'thinking not sent as {type:"adaptive"}', p);
    has((req.body.output_config as { effort?: string })?.effort === 'low', '', 'output_config.effort missing', p);
    has(!json(req.body).includes('budget_tokens'), '', 'budget_tokens present', p);
    has(okStatus(req), '', `status ${req.status}`, p);
  }, p);
  await attempt(async () => {
    offlineQueue(ctx, mock({ content: [thinkingBlock(), textBlock('Paris.')], stop_reason: 'end_turn' }));
    await sdk(ctx).messages.create({
      model: SONNET,
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Capital of France? One word.' }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    has(okStatus(last(ctx)), '', `status ${last(ctx).status}`, s);
  }, s);
  return { id: 'C1', name: 'Adaptive thinking + effort', binding: verdict(p), sdk: verdict(s), evidence, note: [...p, ...s.map((x) => `sdk: ${x}`)].join('; ') };
}

// ---------------------------------------------------------------------------
// C2 explicit effort on Haiku 5.5 and Opus 5.5

export async function c2(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  const parts: string[] = [];
  for (const model of [HAIKU, OPUS]) {
    await attempt(async () => {
      offlineQueue(ctx, mock({ content: [textBlock('Paris.')], stop_reason: 'end_turn' }));
      await chat(ctx, { model, thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } }).invoke('Capital of France? One word.');
      const req = last(ctx);
      parts.push(`${model}: effort=${json((req.body.output_config as { effort?: string })?.effort)} status=${req.status}`);
      has((req.body.output_config as { effort?: string })?.effort === 'low', '', `${model}: effort missing`, p);
      has(okStatus(req), '', `${model}: status ${req.status}`, p);
    }, p);
  }
  return { id: 'C2', name: 'Explicit effort on Haiku 5.5 / Opus 5.5', binding: verdict(p), sdk: 'n/a', evidence: parts.join('; '), note: p.join('; ') };
}

// ---------------------------------------------------------------------------
// C3 strict tools via bindTools + Zod

export async function c3(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  const s: string[] = [];
  const notes: string[] = [];
  let evidence = '';
  await attempt(async () => {
    offlineQueue(
      ctx,
      mock({ content: [thinkingBlock(), toolUseBlock('search_products', { query: 'running shoes', price_max: 50 })], stop_reason: 'tool_use' }),
    );
    const ai = await chat(ctx, { thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } })
      .bindTools([searchProducts], { strict: true })
      .invoke(TOOL_PROMPT);
    const req = last(ctx);
    const sent = (req.body.tools as Record<string, unknown>[] | undefined)?.[0] ?? {};
    const schema = (sent.input_schema ?? {}) as Record<string, unknown>;
    evidence = `tool=${json({ strict: sent.strict, additionalProperties: schema.additionalProperties, required: schema.required })} tool_calls=${json(ai.tool_calls?.map((c) => ({ name: c.name, args: c.args })))} status=${req.status}`;
    has(sent.strict === true, '', 'strict not true on the tool', p);
    has(schema.additionalProperties === false, '', 'additionalProperties is not false', p);
    has(Array.isArray(schema.required) && (schema.required as string[]).includes('query'), '', 'required missing', p);
    has(ai.tool_calls?.[0]?.name === 'search_products', '', 'tool call not parsed into tool_calls', p);
    has(okStatus(req), '', `status ${req.status}`, p);
    if (!ctx.offline && ai.tool_calls?.length === 0) notes.push('live model answered without calling the tool');
  }, p);
  await attempt(async () => {
    offlineQueue(ctx, mock({ content: [toolUseBlock('search_products', { query: 'running shoes', price_max: 50 })], stop_reason: 'tool_use' }));
    await sdk(ctx).messages.create({
      model: SONNET,
      max_tokens: 2048,
      output_config: { effort: 'low' },
      tools: [SEARCH_TOOL_RAW],
      messages: [{ role: 'user', content: TOOL_PROMPT }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    has(okStatus(last(ctx)), '', `status ${last(ctx).status}`, s);
  }, s);
  return { id: 'C3', name: 'Strict tools (bindTools + Zod)', binding: verdict(p, notes), sdk: verdict(s), evidence, note: [...p, ...notes, ...s.map((x) => `sdk: ${x}`)].join('; ') };
}

// ---------------------------------------------------------------------------
// C4 tool_choice never forced

export async function c4(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  const notes: string[] = [];
  const parts: string[] = [];
  const model = () => chat(ctx, { thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } });
  await attempt(async () => {
    offlineQueue(ctx, mock({ content: [textBlock('ok')], stop_reason: 'end_turn' }));
    await model().bindTools([searchProducts]).invoke('Say ok.');
    const tc = last(ctx).body.tool_choice;
    parts.push(`default: tool_choice=${json(tc)}`);
    has(tc === undefined || (tc as { type?: string }).type === 'auto', '', `default sends tool_choice ${json(tc)}`, p);

    offlineQueue(ctx, mock({ content: [textBlock('ok')], stop_reason: 'end_turn' }));
    await model().bindTools([searchProducts], { tool_choice: 'auto' }).invoke('Say ok.');
    const tc2 = last(ctx).body.tool_choice;
    parts.push(`auto: tool_choice=${json(tc2)}`);
    has((tc2 as { type?: string })?.type === 'auto', '', `"auto" sent as ${json(tc2)}`, p);
  }, p);
  // withStructuredOutput is a common way to force a tool by accident; record what it sends.
  await attempt(async () => {
    offlineQueue(ctx, mock({ content: [toolUseBlock('Answer', { answer: 'ok' })], stop_reason: 'tool_use' }));
    await model()
      .withStructuredOutput(z.object({ answer: z.string() }), { name: 'Answer' })
      .invoke('Say ok.')
      .catch(() => undefined);
    const req = last(ctx);
    const tc = req.body.tool_choice;
    parts.push(`withStructuredOutput: tool_choice=${json(tc)} output_config.format=${json((req.body.output_config as { format?: unknown })?.format !== undefined)} status=${req.status}`);
    if ((tc as { type?: string })?.type === 'tool' || (tc as { type?: string })?.type === 'any') {
      notes.push('withStructuredOutput forces tool_choice (400 on Sonnet/Opus 5.5) — the agent must not use it');
    } else {
      notes.push(
        'withStructuredOutput (default method) with thinking on sends an unforced tool call and warns it may throw if the model skips the tool — use outputConfig.format (structured outputs) when JSON output is needed',
      );
    }
  }, notes);
  return { id: 'C4', name: 'tool_choice never forced', binding: verdict(p, notes), sdk: 'n/a', evidence: parts.join('; '), note: [...p, ...notes].join('; ') };
}

// ---------------------------------------------------------------------------
// C5 refusal (mocked in both modes)

export async function c5(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  const s: string[] = [];
  let evidence = '';
  const refusal = () =>
    mock({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'mocked refusal' },
    });
  await attempt(async () => {
    ctx.capture.queue(refusal());
    const ai = await chat(ctx, { thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } }).invoke('anything');
    const meta = ai.response_metadata as Record<string, unknown>;
    const details = (meta.stop_details ?? (ai.additional_kwargs as Record<string, unknown>).stop_details) as { category?: string } | undefined;
    evidence = `response_metadata.stop_reason=${json(meta.stop_reason)} stop_details=${json(details)}`;
    has(meta.stop_reason === 'refusal', '', 'stop_reason "refusal" not readable from the AIMessage', p);
    has(details?.category === 'cyber', '', 'stop_details.category not readable from the AIMessage', p);
  }, p);
  await attempt(async () => {
    ctx.capture.queue(refusal());
    const msg = await sdk(ctx).messages.create({ model: SONNET, max_tokens: 1024, messages: [{ role: 'user', content: 'anything' }] });
    const details = (msg as unknown as { stop_details?: { category?: string } }).stop_details;
    has(msg.stop_reason === 'refusal' && details?.category === 'cyber', '', 'sdk did not surface refusal', s);
  }, s);
  return { id: 'C5', name: 'Refusal stop_reason + stop_details', binding: verdict(p), sdk: verdict(s), evidence, note: [...p, ...s.map((x) => `sdk: ${x}`)].join('; ') };
}

// ---------------------------------------------------------------------------
// C6 thinking blocks round-trip unchanged; C7 replay to Opus 5.5

async function toolTurn(ctx: Ctx): Promise<{ history: BaseMessage[]; turn1: AIMessage }> {
  const model = chat(ctx, { thinking: { type: 'adaptive', display: 'summarized' }, outputConfig: { effort: 'low' } }).bindTools([searchProducts], {
    strict: true,
  });
  offlineQueue(
    ctx,
    mock({
      content: [thinkingBlock('User wants cheap running shoes; search.'), toolUseBlock('search_products', { query: 'running shoes', price_max: 50 })],
      stop_reason: 'tool_use',
    }),
  );
  const user = new HumanMessage(TOOL_PROMPT);
  const turn1 = (await model.invoke([user])) as AIMessage;
  const call = turn1.tool_calls?.[0];
  if (!call) throw new Error('turn 1 made no tool call');
  const result = new ToolMessage({ tool_call_id: call.id ?? '', content: json([{ name: 'Trail Runner', price: 45 }]) });
  return { history: [user, turn1, result], turn1 };
}

function thinkingIn(content: unknown): { thinking: string; signature: string }[] {
  return Array.isArray(content) ? (content.filter((b) => b?.type === 'thinking') as { thinking: string; signature: string }[]) : [];
}

export async function c6c7(ctx: Ctx): Promise<CheckResult[]> {
  const p6: string[] = [];
  const p7: string[] = [];
  let ev6 = '';
  let ev7 = '';
  let history: BaseMessage[] = [];
  let original: { thinking: string; signature: string }[] = [];

  await attempt(async () => {
    const t = await toolTurn(ctx);
    history = t.history;
    original = thinkingIn(t.turn1.content);
    has(original.length > 0, '', 'turn-1 AIMessage content has no thinking block', p6);

    offlineQueue(ctx, mock({ content: [thinkingBlock(), textBlock('Found Trail Runner at $45.')], stop_reason: 'end_turn' }));
    await chat(ctx, { thinking: { type: 'adaptive', display: 'summarized' }, outputConfig: { effort: 'low' } })
      .bindTools([searchProducts], { strict: true })
      .invoke(history);
    const req = last(ctx);
    const sentAssistant = (req.body.messages as { role: string; content: unknown }[]).find((m) => m.role === 'assistant');
    const sent = thinkingIn(sentAssistant?.content);
    ev6 = `turn1 thinking blocks=${original.length}, resent=${sent.length}, identical=${json(sent) === json(original.map((b) => ({ type: 'thinking', thinking: b.thinking, signature: b.signature })))} status=${req.status}`;
    has(sent.length === original.length, '', 'thinking block missing from turn-2 request', p6);
    has(
      sent.every((b, i) => b.signature === original[i]?.signature && b.thinking === original[i]?.thinking),
      '',
      'thinking block changed between response and resend',
      p6,
    );
    has(okStatus(req), '', `status ${req.status}`, p6);
  }, p6);

  await attempt(async () => {
    if (history.length === 0) throw new Error('no history from C6');
    offlineQueue(ctx, mock({ content: [textBlock('Found Trail Runner at $45.')], stop_reason: 'end_turn' }));
    await chat(ctx, { model: OPUS, thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } })
      .bindTools([searchProducts], { strict: true })
      .invoke(history);
    const req = last(ctx);
    const sentAssistant = (req.body.messages as { role: string; content: unknown }[]).find((m) => m.role === 'assistant');
    const sent = thinkingIn(sentAssistant?.content);
    ev7 = `resent to Opus: thinking blocks=${sent.length}, status=${req.status}`;
    has(sent.length === original.length, '', 'binding stripped thinking blocks on model switch', p7);
    has(okStatus(req), '', `status ${req.status}`, p7);
  }, p7);

  return [
    { id: 'C6', name: 'Thinking blocks round-trip unchanged', binding: verdict(p6), sdk: 'n/a', evidence: ev6, note: p6.join('; ') },
    { id: 'C7', name: 'Sonnet history replayed to Opus 5.5', binding: verdict(p7), sdk: 'n/a', evidence: ev7, note: p7.join('; ') },
  ];
}

// ---------------------------------------------------------------------------
// C8 display: 'updates' (beta) progress notes

export async function c8(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  let evidence = '';
  await attempt(async () => {
    offlineQueue(
      ctx,
      mock({
        content: [thinkingBlock('Searching the catalog for shoes under $50.'), toolUseBlock('search_products', { query: 'running shoes', price_max: 50 })],
        stop_reason: 'tool_use',
      }),
    );
    const ai = (await chat(ctx, {
      thinking: { type: 'adaptive', display: 'updates' },
      outputConfig: { effort: 'low' },
      betas: ['thinking-display-updates-2026-08-18'],
    })
      .bindTools([searchProducts], { strict: true })
      .invoke(TOOL_PROMPT)) as AIMessage;
    const req = last(ctx);
    const beta = req.headers['anthropic-beta'] ?? '';
    const notes = thinkingIn(ai.content).map((b) => b.thinking);
    evidence = `thinking=${json(req.body.thinking)} anthropic-beta=${json(beta)} notes=${json(notes)} status=${req.status}`;
    has((req.body.thinking as { display?: string })?.display === 'updates', '', 'display "updates" not sent', p);
    has(beta.includes('thinking-display-updates-2026-08-18'), '', 'beta header not sent', p);
    has(thinkingIn(ai.content).length > 0, '', 'thinking blocks not on the AIMessage', p);
    has(okStatus(req), '', `status ${req.status}`, p);
  }, p);
  return { id: 'C8', name: 'Thinking display "updates" (beta)', binding: verdict(p), sdk: 'n/a', evidence, note: p.join('; ') };
}

// ---------------------------------------------------------------------------
// C9 mid-conversation system message

export async function c9(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  let evidence = '';
  await attempt(async () => {
    offlineQueue(ctx, mock({ content: [textBlock('Two items.')], stop_reason: 'end_turn' }));
    await chat(ctx, { thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } }).invoke([
      new SystemMessage('You are the Aljo Store shopping assistant.'),
      new HumanMessage('Hi'),
      new AIMessage('Hello! How can I help?'),
      new HumanMessage('How many items are in my cart?'),
      new SystemMessage('Cart snapshot: 2 items, subtotal $90.00.'),
    ]);
    const req = last(ctx);
    const roles = (req.body.messages as { role: string }[]).map((m) => m.role);
    evidence = `top-level system=${json(req.body.system)} message roles=${json(roles)} status=${req.status}`;
    has(json(req.body.system).includes('shopping assistant'), '', 'leading system message not hoisted to top-level system', p);
    has(roles.at(-1) === 'system', '', 'mid-conversation system message not kept in place as role "system"', p);
    has(!json(req.body.system).includes('Cart snapshot'), '', 'mid-conversation system message merged into top-level system', p);
    has(okStatus(req), '', `status ${req.status}`, p);
  }, p);
  return { id: 'C9', name: 'Mid-conversation system message', binding: verdict(p), sdk: 'n/a', evidence, note: p.join('; ') };
}

// ---------------------------------------------------------------------------
// C10 prompt caching usage

const LONG_SYSTEM = `You are the Aljo Store shopping assistant. ${'Store rules: be accurate, cite sources, never invent prices. '.repeat(400)}`;

export async function c10(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  const notes: string[] = [];
  let evidence = '';
  await attempt(async () => {
    const run = () =>
      chat(ctx, { thinking: { type: 'adaptive' }, outputConfig: { effort: 'low' } })
        .bindTools([searchProducts], { strict: true })
        .invoke([
          new SystemMessage({ content: [{ type: 'text', text: LONG_SYSTEM, cache_control: { type: 'ephemeral' } }] }),
          new HumanMessage('Say ok.'),
        ]);
    offlineQueue(
      ctx,
      mock({ content: [textBlock('ok')], stop_reason: 'end_turn', usage: { cache_creation_input_tokens: 4000 } }),
      mock({ content: [textBlock('ok')], stop_reason: 'end_turn', usage: { cache_read_input_tokens: 4000 } }),
    );
    await run();
    const second = (await run()) as AIMessage;
    const req = last(ctx);
    const sentCache = json(req.body.system).includes('"cache_control"');
    const read = second.usage_metadata?.input_token_details?.cache_read;
    evidence = `system cache_control sent=${sentCache} usage_metadata.input_token_details=${json(second.usage_metadata?.input_token_details)} status=${req.status}`;
    has(sentCache, '', 'cache_control dropped from the system block', p);
    has(typeof read === 'number' && read > 0, '', 'cache_read not reported in usage_metadata on the second call', p);
    if (ctx.offline) notes.push('offline: proves the binding passes cache_control and reports cache usage; a real cache hit needs the live run');
  }, p);
  return { id: 'C10', name: 'Prompt caching usage', binding: verdict(p, notes), sdk: 'n/a', evidence, note: [...p, ...notes].join('; ') };
}

// ---------------------------------------------------------------------------
// C11 server-side refusal fallbacks

export async function c11(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  const notes: string[] = [];
  let evidence = '';
  await attempt(async () => {
    offlineQueue(ctx, mock({ content: [textBlock('ok')], stop_reason: 'end_turn' }));
    await chat(ctx, {
      thinking: { type: 'adaptive' },
      outputConfig: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      invocationKwargs: { fallbacks: 'default' },
    }).invoke('Say ok.');
    const req = last(ctx);
    const beta = req.headers['anthropic-beta'] ?? '';
    evidence = `fallbacks=${json(req.body.fallbacks)} anthropic-beta=${json(beta)} status=${req.status}`;
    has(req.body.fallbacks === 'default', '', 'fallbacks not sent', p);
    has(beta.includes('server-side-fallback-2026-07-01'), '', 'beta header not sent', p);
    has(okStatus(req), '', `status ${req.status}`, p);
    notes.push('no first-class option: passed through invocationKwargs');
  }, p);
  return { id: 'C11', name: 'Server-side refusal fallbacks', binding: verdict(p, notes), sdk: 'n/a', evidence, note: [...p, ...notes].join('; ') };
}

// ---------------------------------------------------------------------------
// C12 streaming: .stream() and streamEvents

export async function c12(ctx: Ctx): Promise<CheckResult> {
  const p: string[] = [];
  let evidence = '';
  const streamed = () =>
    mock({
      content: [
        thinkingBlock('Searching.'),
        textBlock('Let me search.'),
        toolUseBlock('search_products', { query: 'running shoes', price_max: 50 }),
      ],
      stop_reason: 'tool_use',
    });
  await attempt(async () => {
    const model = chat(ctx, { thinking: { type: 'adaptive', display: 'summarized' }, outputConfig: { effort: 'low' } }).bindTools([searchProducts], {
      strict: true,
    });

    offlineQueue(ctx, streamed());
    let full: AIMessageChunk | undefined;
    let chunks = 0;
    for await (const chunk of await model.stream(TOOL_PROMPT)) {
      chunks += 1;
      full = full ? full.concat(chunk) : chunk;
    }
    const req = last(ctx);
    const thinking = thinkingIn(full?.content);
    const text = Array.isArray(full?.content) ? full.content.some((b) => (b as { type?: string }).type === 'text') : typeof full?.content === 'string';
    const calls = full?.tool_calls ?? [];

    offlineQueue(ctx, streamed());
    let events = 0;
    for await (const event of model.streamEvents(TOOL_PROMPT, { version: 'v2' })) {
      if (event.event === 'on_chat_model_stream') events += 1;
    }

    evidence = `stream=${json(req.body.stream)} chunks=${chunks} thinking=${thinking.length} (signature ${thinking[0]?.signature ? 'present' : 'missing'}) text=${text} tool_calls=${json(calls.map((c) => ({ name: c.name, args: c.args })))} streamEvents chat chunks=${events}`;
    has(req.body.stream === true, '', 'request not streamed', p);
    has(chunks > 1, '', 'stream produced a single chunk', p);
    has(thinking.length > 0 && Boolean(thinking[0]?.signature), '', 'thinking block or its signature missing from the aggregated stream', p);
    has(calls[0]?.name === 'search_products' && (calls[0]?.args as { price_max?: number })?.price_max !== undefined, '', 'tool call not assembled from the stream', p);
    has(events > 0, '', 'streamEvents emitted no on_chat_model_stream events', p);
  }, p);
  return { id: 'C12', name: 'Streaming (.stream + streamEvents)', binding: verdict(p), sdk: 'n/a', evidence, note: p.join('; ') };
}

export function newCtx(offline: boolean): Ctx {
  return { offline, capture: createCapture(offline) };
}
