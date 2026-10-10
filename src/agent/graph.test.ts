import { describe, it, expect, vi } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver } from '@langchain/langgraph';
import { STEP_BUDGET } from './config';
import { buildAgentGraph, createChatModel, createEscalationModel, RECURSION_LIMIT } from './graph';
import logger from '../utils/logger';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GIVE_UP_REPLY, REFUSAL_REPLY, SYSTEM_PROMPT } from './prompt';
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
    // What the chat service sends with each new message: the per-turn state starts again.
    { messages: [new HumanMessage(message)], toolCalls: 0, escalated: false, turnCalls: [] },
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

  it(`stops a turn after ${STEP_BUDGET} tool calls and answers every pending call (no escalation model)`, async () => {
    const looping = recordingTool('search_products');
    const model = new ScriptedChatModel(Array.from({ length: STEP_BUDGET + 3 }, (_, i) => toolCall('search_products', { query: `q${i}` })));
    const messages = await run(model, [looping]);
    expect(looping.runs).toHaveLength(STEP_BUDGET);
    expect(lastText(messages)).toBe(GIVE_UP_REPLY);
    // Every tool call in history has a result, so the next turn's request stays valid.
    const callIds = messages.flatMap((m) => (m as AIMessage).tool_calls?.map((c) => c.id) ?? []);
    const resultIds = messages.filter((m) => m instanceof ToolMessage).map((m) => (m as ToolMessage).tool_call_id);
    expect(resultIds.sort()).toEqual(callIds.sort());
  });

  it('counts tool calls per turn, not per conversation', async () => {
    const tool = recordingTool('search_products');
    const fiveCalls = () => [...Array.from({ length: 5 }, (_, i) => toolCall('search_products', { query: `q${i}` })), new AIMessage('done')];
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

describe('Opus escalation (spec 015)', () => {
  const confirmedMeta = { kind: 'write', confirmRequired: true } as const;
  type Recorded = ReturnType<typeof recordingTool>;

  /** A tool that fails the first `failures` times, then succeeds. */
  const flaky = (name: string, failures: number, limited = false) => {
    const runs: unknown[] = [];
    const t = tool(
      async (args: Record<string, unknown>) => {
        runs.push(args);
        return runs.length <= failures ? JSON.stringify({ error: 'Lookup failed.', ...(limited ? { limited: true } : {}) }) : '{"ok":true}';
      },
      { name, description: `Test tool ${name}`, schema: z.object({}).passthrough() },
    );
    return { tool: t, runs };
  };

  const setup = (sonnetScript: AIMessage[], opusScript: AIMessage[], tools: Recorded[], allow: () => Promise<boolean> = async () => true) => {
    const sonnet = new ScriptedChatModel(sonnetScript);
    const opus = new ScriptedChatModel(opusScript);
    const graph = buildAgentGraph({
      model: sonnet,
      tools: tools.map((t) => t.tool),
      checkpointer: new MemorySaver(),
      userId: 'u1',
      summarize: async () => 'Remove all items?',
      escalation: { model: opus, allow },
    });
    const config = { configurable: { thread_id: 'esc' }, recursionLimit: RECURSION_LIMIT };
    const start = async (text = 'help') =>
      (await graph.invoke({ messages: [new HumanMessage(text)], toolCalls: 0, escalated: false, turnCalls: [] }, config)) as {
        messages: BaseMessage[];
        __interrupt__?: unknown[];
      };
    const resume = (approved: boolean) => graph.invoke(new Command({ resume: { approved } }), config) as Promise<{ messages: BaseMessage[] }>;
    return { sonnet, opus, start, resume };
  };

  const allAnswered = (messages: BaseMessage[]) => {
    const callIds = messages.flatMap((m) => (m as AIMessage).tool_calls?.map((c) => c.id) ?? []);
    const resultIds = messages.filter((m) => m instanceof ToolMessage).map((m) => (m as ToolMessage).tool_call_id);
    return [...resultIds].sort().join() === [...callIds].sort().join();
  };

  const escalationLogs = () => {
    const warn = vi.spyOn(logger, 'warn');
    warn.mockClear();
    return () => warn.mock.calls.filter(([event]) => event === 'AGENT_ESCALATION').map(([, data]) => data);
  };

  it('hands the turn to Opus when the step budget runs out', async () => {
    const logs = escalationLogs();
    const search = recordingTool('search_products');
    const sonnetScript = Array.from({ length: STEP_BUDGET + 1 }, (_, i) => toolCall('search_products', { query: `q${i}` }));
    const { sonnet, opus, start } = setup(sonnetScript, [new AIMessage('Here is what I found.')], [search]);
    const { messages } = await start();
    expect(search.runs).toHaveLength(STEP_BUDGET);
    expect(sonnet.calls).toHaveLength(STEP_BUDGET + 1);
    expect(opus.calls).toHaveLength(1);
    expect(lastText(messages)).toBe('Here is what I found.');
    expect(allAnswered(messages)).toBe(true);
    expect(logs()).toEqual([{ userId: 'u1', thread: 'esc', reason: 'step_budget', outcome: 'escalated' }]);
  });

  it('treats a third identical call as a loop, and does not run it', async () => {
    const logs = escalationLogs();
    const search = recordingTool('search_products');
    const same = () => toolCall('search_products', { query: 'shoes', price_max: 50 });
    const reordered = toolCall('search_products', { price_max: 50, query: 'shoes' });
    const { opus, start } = setup([same(), same(), reordered], [new AIMessage('Done.')], [search]);
    const { messages } = await start();
    expect(search.runs).toHaveLength(2);
    expect(opus.calls).toHaveLength(1);
    // Opus sees what was tried, and that the third call was handed over.
    expect(opus.calls[0]!.some((m) => m instanceof ToolMessage && String(m.content).includes('handing this over'))).toBe(true);
    expect(logs()).toEqual([{ userId: 'u1', thread: 'esc', reason: 'loop', outcome: 'escalated' }]);
    expect(allAnswered(messages)).toBe(true);
  });

  it('escalates when the same tool fails twice in a row', async () => {
    const logs = escalationLogs();
    const lookup = flaky('get_order_status', 5);
    const { opus, start } = setup(
      [toolCall('get_order_status', { order_id: 'a' }), toolCall('get_order_status', { order_id: 'b' })],
      [new AIMessage('I could not find it.')],
      [lookup],
    );
    await start();
    expect(lookup.runs).toHaveLength(2);
    expect(opus.calls).toHaveLength(1);
    expect(logs()).toEqual([{ userId: 'u1', thread: 'esc', reason: 'repeated_tool_error', outcome: 'escalated' }]);
  });

  it('never escalates a normal turn', async () => {
    const scenarios: { script: AIMessage[]; tools: Recorded[] }[] = [
      // Two identical calls: a reasonable retry.
      { script: [toolCall('view_cart'), toolCall('view_cart'), new AIMessage('ok')], tools: [recordingTool('view_cart')] },
      // One failure, then success.
      { script: [toolCall('get_order_status', { order_id: 'a' }), toolCall('get_order_status', { order_id: 'a' }), new AIMessage('ok')], tools: [flaky('get_order_status', 1)] },
      // Failures from different tools.
      {
        script: [toolCall('get_order_status', { order_id: 'a' }), toolCall('view_orders'), new AIMessage('ok')],
        tools: [flaky('get_order_status', 9), flaky('view_orders', 9)],
      },
      // A per-user limit refusal twice: retrying won't help, and neither would Opus.
      { script: [toolCall('add_to_cart', { product_id: 'p1' }), toolCall('add_to_cart', { product_id: 'p2' }), new AIMessage('ok')], tools: [flaky('add_to_cart', 9, true)] },
      // Exactly the step budget.
      {
        script: [...Array.from({ length: STEP_BUDGET }, (_, i) => toolCall('search_products', { query: `q${i}` })), new AIMessage('ok')],
        tools: [recordingTool('search_products')],
      },
    ];
    for (const { script, tools } of scenarios) {
      const { opus, start } = setup(script, [], tools);
      const { messages } = await start();
      expect(opus.calls, script.map((m) => m.tool_calls?.[0]?.name ?? 'answer').join(',')).toHaveLength(0);
      expect(lastText(messages)).toBe('ok');
    }
  });

  it('does not count a declined confirmation as a failure', async () => {
    const clear = recordingTool('clear_cart', {}, confirmedMeta);
    const { opus, start, resume } = setup([toolCall('clear_cart'), toolCall('clear_cart'), new AIMessage('ok')], [], [clear]);
    await start();
    await resume(false);
    await resume(false);
    expect(clear.runs).toHaveLength(0);
    expect(opus.calls).toHaveLength(0);
  });

  it('escalates once: if Opus is stuck too, the turn ends with the support offer', async () => {
    const warn = vi.spyOn(logger, 'warn');
    warn.mockClear();
    const search = recordingTool('search_products');
    const same = () => toolCall('search_products', { query: 'x' });
    const { sonnet, opus, start } = setup([same(), same(), same()], [same(), same(), same()], [search]);
    const { messages } = await start();
    expect(sonnet.calls).toHaveLength(3);
    expect(opus.calls).toHaveLength(3);
    expect(search.runs).toHaveLength(4);
    expect(lastText(messages)).toBe(GIVE_UP_REPLY);
    expect(allAnswered(messages)).toBe(true);
    expect(warn).toHaveBeenCalledWith('AGENT_TURN_STOPPED', { userId: 'u1', thread: 'esc', reason: 'loop', escalated: true });
  });

  it('keeps the confirmation gate for Opus', async () => {
    const lookup = flaky('get_order_status', 9);
    const clear = recordingTool('clear_cart', {}, confirmedMeta);
    const { start, resume } = setup(
      [toolCall('get_order_status', { order_id: 'a' }), toolCall('get_order_status', { order_id: 'b' })],
      [toolCall('clear_cart'), new AIMessage('Cleared.')],
      [lookup, clear],
    );
    const paused = await start();
    expect(paused.__interrupt__).toHaveLength(1);
    expect(clear.runs).toHaveLength(0);
    const { messages } = await resume(true);
    expect(clear.runs).toHaveLength(1);
    expect(lastText(messages)).toBe('Cleared.');
  });

  it('goes straight to the support offer when the escalation budget is spent', async () => {
    const logs = escalationLogs();
    const same = () => toolCall('view_cart');
    const { opus, start } = setup([same(), same(), same()], [new AIMessage('never')], [recordingTool('view_cart')], async () => false);
    const { messages } = await start();
    expect(opus.calls).toHaveLength(0);
    expect(lastText(messages)).toBe(GIVE_UP_REPLY);
    expect(logs()).toEqual([{ userId: 'u1', thread: 'esc', reason: 'loop', outcome: 'over_budget' }]);
  });

  it('sends Opus the same prompt and tools, with adaptive thinking and medium effort', async () => {
    const bodies: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- captured JSON body
    const fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const message = {
        id: 'msg_opus',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Sorted.' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      };
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const config = { enabled: true, anthropicApiKey: 'test-key', voyageApiKey: '', tracing: { enabled: false, apiKey: '', project: '' } };
    const same = () => toolCall('view_cart');
    const graph = buildAgentGraph({
      model: new ScriptedChatModel([same(), same(), same()]),
      tools: [recordingTool('view_cart').tool],
      checkpointer: new MemorySaver(),
      userId: 'u1',
      escalation: { model: createEscalationModel(config, { fetch, maxRetries: 0 }), allow: async () => true },
    });
    const state = await graph.invoke({ messages: [new HumanMessage('hi')], toolCalls: 0, escalated: false, turnCalls: [] }, { configurable: { thread_id: 'opus' } });

    const body = bodies[0]!;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body.tools[0]).toMatchObject({ name: 'view_cart', strict: true });
    expect(body.tool_choice).toBeUndefined();
    // The whole visible history: the question, three calls and their results.
    expect(body.messages.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(3);
    expect(lastText(state.messages as BaseMessage[])).toBe('Sorted.');
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
    expect(events(['messages', [new AIMessage('Stopped.'), { langgraph_node: 'give_up' }]])).toEqual([
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
