import { describe, it, expect, vi } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { STEP_BUDGET } from './config';
import { buildAgentGraph, createChatModel, RECURSION_LIMIT } from './graph';
import { REFUSAL_REPLY, STEP_BUDGET_REPLY, SYSTEM_PROMPT } from './prompt';
import { toAgentEvents, toolStartEvent, visibleText } from './stream';
import { memoryLimiters, recordingTool, ScriptedChatModel, toolCall } from './test-utils';
import { setAgentLimiters } from './limits';
import { withWriteLimit } from './tools/write-limit';
import { askStoreKnowledgeTool } from './tools/ask-store-knowledge';

const knowledge = vi.hoisted(() => ({ askKnowledge: vi.fn() }));
vi.mock('./rag/knowledge.js', () => knowledge);

const run = async (model: ScriptedChatModel, tools: ReturnType<typeof recordingTool>[], threadId = 't1', message = 'hi', checkpointer = new MemorySaver()) => {
  const graph = buildAgentGraph({ model, tools: tools.map((t) => t.tool), checkpointer, userId: 'u1' });
  const state = await graph.invoke(
    { messages: [new HumanMessage(message)], toolCalls: 0 },
    { configurable: { thread_id: threadId }, recursionLimit: RECURSION_LIMIT },
  );
  return state.messages as BaseMessage[];
};

const lastText = (messages: BaseMessage[]) => visibleText(messages.at(-1)!.content);

describe('agent graph', () => {
  it('calls a tool, then answers from its result', async () => {
    const search = recordingTool('search_products', { results: [{ name: 'Trail Runner' }] });
    const model = new ScriptedChatModel([toolCall('search_products', { query: 'shoes' }), new AIMessage('Found Trail Runner.')]);
    const messages = await run(model, [search]);
    expect(search.runs).toEqual([{ query: 'shoes' }]);
    expect(lastText(messages)).toBe('Found Trail Runner.');
    // The second model call saw the tool result.
    expect(model.calls[1]!.some((m) => m instanceof ToolMessage && String(m.content).includes('Trail Runner'))).toBe(true);
  });

  it('sends the cached system prompt first on every call and binds tools strictly', async () => {
    const model = new ScriptedChatModel([toolCall('view_cart'), new AIMessage('Your cart is empty.')]);
    await run(model, [recordingTool('view_cart')]);
    for (const call of model.calls) {
      expect(call[0]!.getType()).toBe('system');
      expect(call[0]!.content).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    }
    expect(model.bindings[0]!.kwargs).toEqual({ strict: true });
  });

  it(`stops a turn after ${STEP_BUDGET} tool calls and answers every pending call`, async () => {
    const looping = recordingTool('search_products');
    const model = new ScriptedChatModel(Array.from({ length: STEP_BUDGET + 3 }, () => toolCall('search_products')));
    const messages = await run(model, [looping]);
    expect(looping.runs).toHaveLength(STEP_BUDGET);
    expect(lastText(messages)).toBe(STEP_BUDGET_REPLY);
    // Every tool call in history has a result, so the next turn's request stays valid.
    const callIds = messages.flatMap((m) => (m as AIMessage).tool_calls?.map((c) => c.id) ?? []);
    const resultIds = messages.filter((m) => m instanceof ToolMessage).map((m) => (m as ToolMessage).tool_call_id);
    expect(resultIds.sort()).toEqual(callIds.sort());
  });

  it('counts tool calls per turn, not per conversation', async () => {
    const tool = recordingTool('search_products');
    const fiveCalls = () => [...Array.from({ length: 5 }, () => toolCall('search_products')), new AIMessage('done')];
    const model = new ScriptedChatModel([...fiveCalls(), ...fiveCalls()]);
    const checkpointer = new MemorySaver();
    await run(model, [tool], 'same-thread', 'first', checkpointer);
    const messages = await run(model, [tool], 'same-thread', 'second', checkpointer);
    expect(tool.runs).toHaveLength(10);
    expect(lastText(messages)).toBe('done');
  });

  it('ends a refused turn with the safe reply and runs no tool', async () => {
    const tool = recordingTool('view_orders');
    const refusal = toolCall('view_orders');
    refusal.response_metadata = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } };
    const messages = await run(new ScriptedChatModel([refusal]), [tool]);
    expect(tool.runs).toHaveLength(0);
    expect(lastText(messages)).toBe(REFUSAL_REPLY);
  });
});

describe('store knowledge (spec 013)', () => {
  it('looks up a policy without asking for confirmation and answers from the passage', async () => {
    knowledge.askKnowledge.mockResolvedValue({
      found: true,
      passages: [{ id: 'shipping.md#how-much-does-shipping-cost', topic: 'Shipping', question: 'How much does shipping cost?', text: 'Shipping is free on every order.', score: 0.9 }],
    });
    const model = new ScriptedChatModel([
      toolCall('ask_store_knowledge', { question: 'How much does shipping cost?' }),
      new AIMessage('Per our shipping policy, shipping is free on every order.'),
    ]);
    const graph = buildAgentGraph({ model, tools: [askStoreKnowledgeTool({ userId: 'u1' })], checkpointer: new MemorySaver(), userId: 'u1' });
    const state = await graph.invoke(
      { messages: [new HumanMessage('do I pay for shipping?')], toolCalls: 0 },
      { configurable: { thread_id: 'k1' }, recursionLimit: RECURSION_LIMIT },
    );
    expect(knowledge.askKnowledge).toHaveBeenCalledWith('How much does shipping cost?');
    expect(lastText(state.messages as BaseMessage[])).toBe('Per our shipping policy, shipping is free on every order.');
    expect(model.calls[1]!.some((m) => m instanceof ToolMessage && String(m.content).includes('free on every order'))).toBe(true);
    expect(toolStartEvent('ask_store_knowledge')).toEqual({ event: 'tool_start', data: { tool: 'ask_store_knowledge', label: 'Checking store policies…' } });
  });
});

describe('request sent to Claude', () => {
  it('has the system prompt first, adaptive thinking, explicit effort, strict tools and no tool_choice', async () => {
    const bodies: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- captured JSON body
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const message = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      };
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const model = createChatModel(
      { enabled: true, anthropicApiKey: 'test-key', voyageApiKey: '', tracing: { enabled: false, apiKey: '', project: '' } },
      { fetch, maxRetries: 0 },
    );
    const graph = buildAgentGraph({ model, tools: [recordingTool('view_cart').tool], checkpointer: new MemorySaver(), userId: 'u1' });
    await graph.invoke({ messages: [new HumanMessage('hi')], toolCalls: 0 }, { configurable: { thread_id: 'req' } });

    const body = bodies[0]!;
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.tools[0]).toMatchObject({ name: 'view_cart', strict: true });
    expect(body.tool_choice).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('stream mapping', () => {
  const events = (chunk: [string, unknown]) => [...toAgentEvents(chunk)];

  it('turns agent text into tokens and skips thinking, tool input and other nodes', () => {
    const chunk = new AIMessageChunk({
      content: [
        { type: 'thinking', thinking: 'secret reasoning' },
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'x', name: 'view_cart', input: '{}' },
      ],
    });
    expect(events(['messages', [chunk, { langgraph_node: 'agent' }]])).toEqual([{ event: 'token', data: { text: 'Hello' } }]);
    expect(events(['messages', [new AIMessage('Stopped.'), { langgraph_node: 'budget_exceeded' }]])).toEqual([
      { event: 'token', data: { text: 'Stopped.' } },
    ]);
    expect(events(['messages', [new ToolMessage({ tool_call_id: 'x', content: '{}' }), { langgraph_node: 'tools' }]])).toEqual([]);
  });

  it('emits tool_start for the agent\'s tool calls and tool_end for their results', () => {
    expect(events(['updates', { agent: { messages: [toolCall('view_cart')] } }])).toEqual([
      { event: 'tool_start', data: { tool: 'view_cart', label: 'Checking your cart…' } },
    ]);
    const ok = new ToolMessage({ tool_call_id: 'a', name: 'view_cart', content: '{"items":[]}' });
    const failed = new ToolMessage({ tool_call_id: 'b', name: 'get_order_status', content: '{"error":"No order with that id on your account."}' });
    expect(events(['updates', { tools: { messages: [ok, failed] } }])).toEqual([
      { event: 'tool_end', data: { tool: 'view_cart', ok: true } },
      { event: 'tool_end', data: { tool: 'get_order_status', ok: false } },
    ]);
  });

  it('maps an interrupt to confirm_required with its id', () => {
    const interrupt = { id: 'int-1', value: { tool: 'clear_cart', args: {}, summary: 'Remove 2 items?' } };
    expect(events(['updates', { __interrupt__: [interrupt] }])).toEqual([
      { event: 'confirm_required', data: { interruptId: 'int-1', tool: 'clear_cart', summary: 'Remove 2 items?' } },
    ]);
  });
});

describe('confirmation gate', () => {
  const write = { kind: 'write', confirmRequired: false } as const;
  const confirmed = { kind: 'write', confirmRequired: true } as const;

  const setup = (script: AIMessage[]) => {
    const add = recordingTool('add_to_cart', { itemsCount: 1 }, write);
    const clear = recordingTool('clear_cart', { itemsCount: 0 }, confirmed);
    const model = new ScriptedChatModel(script);
    const graph = buildAgentGraph({
      model,
      tools: [add.tool, clear.tool],
      checkpointer: new MemorySaver(),
      userId: 'u1',
      summarize: async (call) => `Confirm ${call.name}: remove all 2 items ($90.00)?`,
    });
    const config = { configurable: { thread_id: 'gate' }, recursionLimit: RECURSION_LIMIT };
    const start = (text: string) => graph.invoke({ messages: [new HumanMessage(text)], toolCalls: 0 }, config);
    const resume = (approved: boolean) => graph.invoke(new Command({ resume: { approved } }), config);
    return { add, clear, model, start, resume };
  };

  const toolResultsIn = (messages: BaseMessage[]) => messages.filter((m) => m instanceof ToolMessage) as ToolMessage[];

  describe('with per-user write limits (spec 014)', () => {
    const limitedSetup = (script: AIMessage[]) => {
      const clear = recordingTool('clear_cart', { itemsCount: 0 }, confirmed);
      const graph = buildAgentGraph({
        model: new ScriptedChatModel(script),
        tools: [withWriteLimit(clear.tool as never, { userId: 'u1' })],
        checkpointer: new MemorySaver(),
        userId: 'u1',
        summarize: async () => 'Remove all items?',
      });
      const config = { configurable: { thread_id: 'limited' }, recursionLimit: RECURSION_LIMIT };
      return {
        clear,
        start: () => graph.invoke({ messages: [new HumanMessage('empty my cart')], toolCalls: 0 }, config),
        resume: (approved: boolean) => graph.invoke(new Command({ resume: { approved } }), config),
      };
    };

    it('a confirmed action over the limit does not run, and the model is told why', async () => {
      const limiters = memoryLimiters({ writes: 1 });
      await limiters.writes.consume('u1');
      setAgentLimiters(limiters);
      const { clear, start, resume } = limitedSetup([toolCall('clear_cart'), new AIMessage('Please wait a bit.')]);
      await start();
      const state = await resume(true);
      expect(clear.runs).toHaveLength(0);
      expect(toolResultsIn(state.messages).at(-1)?.content).toContain("You've made a lot of changes in a short time.");
    });

    it('a declined action uses none of the budget', async () => {
      const limiters = memoryLimiters({ writes: 1 });
      setAgentLimiters(limiters);
      const { clear, start, resume } = limitedSetup([toolCall('clear_cart'), new AIMessage('Okay.')]);
      await start();
      await resume(false);
      expect(clear.runs).toHaveLength(0);
      await expect(limiters.writes.consume('u1')).resolves.toBeTruthy();
    });
  });

  it('runs single-item cart writes straight away', async () => {
    const { add, start } = setup([toolCall('add_to_cart', { product_id: 'p1' }), new AIMessage('Added.')]);
    const state = await start('add it');
    expect(add.runs).toEqual([{ product_id: 'p1' }]);
    expect((state as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
    expect(lastText(state.messages)).toBe('Added.');
  });

  it('pauses clear_cart with the server summary and changes nothing until confirmed', async () => {
    const { clear, start } = setup([toolCall('clear_cart')]);
    const state = (await start('empty my cart')) as { __interrupt__?: { id: string; value: unknown }[] };
    expect(state.__interrupt__?.[0]?.value).toEqual({ tool: 'clear_cart', args: {}, summary: 'Confirm clear_cart: remove all 2 items ($90.00)?' });
    expect(state.__interrupt__?.[0]?.id).toBeTruthy();
    expect(clear.runs).toHaveLength(0);
  });

  it('runs clear_cart exactly once when the customer confirms', async () => {
    const { clear, start, resume } = setup([toolCall('clear_cart'), new AIMessage('Your cart is empty now.')]);
    await start('empty my cart');
    const state = await resume(true);
    expect(clear.runs).toHaveLength(1);
    expect(lastText(state.messages)).toBe('Your cart is empty now.');
  });

  it('never runs clear_cart when the customer declines, and answers the pending call', async () => {
    const { clear, model, start, resume } = setup([toolCall('clear_cart'), new AIMessage('Okay, I left your cart as it is.')]);
    await start('empty my cart');
    const state = await resume(false);
    expect(clear.runs).toHaveLength(0);
    expect(toolResultsIn(state.messages).map((m) => m.content)).toEqual(['{"error":"Not run: the customer declined."}']);
    expect(model.calls[1]!.some((m) => m instanceof ToolMessage)).toBe(true);
    expect(lastText(state.messages)).toBe('Okay, I left your cart as it is.');
  });

  it('runs nothing when one message asks for two confirm-required actions', async () => {
    const twoClears = new AIMessage({
      content: '',
      tool_calls: [
        { id: 'c1', name: 'clear_cart', args: {}, type: 'tool_call' },
        { id: 'c2', name: 'clear_cart', args: {}, type: 'tool_call' },
        { id: 'c3', name: 'add_to_cart', args: { product_id: 'p1' }, type: 'tool_call' },
      ],
    });
    const { add, clear, start } = setup([twoClears, new AIMessage('One at a time, please.')]);
    const state = await start('clear it twice');
    expect(clear.runs).toHaveLength(0);
    expect(add.runs).toHaveLength(0);
    expect(toolResultsIn(state.messages).map((m) => m.tool_call_id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect((state as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
  });
});
