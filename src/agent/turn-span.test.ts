// The agent.turn span, model-call usage and log trace ids (spec 017), with an in-memory exporter.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import { tracing } from '@opentelemetry/sdk-node';

const memory = new tracing.InMemorySpanExporter();
const { flushTraces, startTracing, stopTracing } = await import('../tracing');
startTracing([memory], { immediate: true });
afterAll(() => stopTracing());

vi.mock('./tools/index.js', async () => {
  const { recordingTool } = await import('./test-utils');
  const search = recordingTool('search_products', { results: [] });
  const clear = recordingTool('clear_cart', {}, { kind: 'write', confirmRequired: true });
  return { buildToolsForRequest: () => [search.tool, clear.tool], summarizeConfirmation: async () => 'Remove all items?' };
});

const { AIMessage } = await import('@langchain/core/messages');
const { MemorySaver } = await import('@langchain/langgraph');
const { runChatTurn } = await import('./chat.service');
const { ScriptedChatModel, toolCall, memoryLimiters } = await import('./test-utils');
const { setAgentLimiters } = await import('./limits');
const { usageOf } = await import('./graph');
const { default: logger, withTraceIds } = await import('../utils/logger');

const config = { enabled: true, anthropicApiKey: 'k', voyageApiKey: 'v', tracing: { enabled: false, apiKey: '', project: '' } };
const turnSpans = () => memory.getFinishedSpans().filter((s) => s.name === 'agent.turn');

async function run(sonnet: InstanceType<typeof AIMessage>[], opus?: InstanceType<typeof AIMessage>[]) {
  const deps = {
    createModel: () => new ScriptedChatModel(sonnet),
    ...(opus ? { createEscalationModel: () => new ScriptedChatModel(opus) } : {}),
    createCheckpointer: () => new MemorySaver(),
    claimConfirmation: async () => true,
  };
  const events = runChatTurn({ config, userId: 'user-123', message: 'hi' }, deps);
  while (!(await events.next()).done) {
    // drain the turn
  }
  // Spans are exported asynchronously, even one by one: wait for them.
  await flushTraces();
  return turnSpans().at(-1)!;
}

beforeAll(() => setAgentLimiters(memoryLimiters()));
beforeEach(() => memory.reset());

describe('agent.turn span', () => {
  it('records an answered turn with ids and counts only', async () => {
    const span = await run([toolCall('search_products', { query: 'shoes' }), new AIMessage('Found some.')]);
    expect(span.attributes).toMatchObject({ 'agent.kind': 'message', 'agent.outcome': 'answered', 'agent.tool_calls': 1, 'agent.escalated': false, 'agent.prompt_version': 6 });
    expect(span.attributes['agent.user']).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(memory.getFinishedSpans().map((s) => s.attributes))).not.toContain('user-123');
  });

  it('records a pause for confirmation', async () => {
    const span = await run([toolCall('clear_cart')]);
    expect(span.attributes['agent.outcome']).toBe('confirm_required');
  });

  it('records an escalation and its reason', async () => {
    const same = () => toolCall('search_products', { query: 'x' });
    const span = await run([same(), same(), same()], [new AIMessage('Sorted.')]);
    expect(span.attributes).toMatchObject({ 'agent.outcome': 'answered', 'agent.escalated': true, 'agent.escalation_reason': 'loop' });
    expect(memory.getFinishedSpans().some((s) => s.name === 'chat claude-opus-5-5')).toBe(true);
  });

  it('records a turn that ended with the support offer', async () => {
    const same = () => toolCall('search_products', { query: 'x' });
    const span = await run([same(), same(), same()]);
    expect(span.attributes['agent.outcome']).toBe('gave_up');
  });
});

describe('model-call usage and the prompt-cache hit rate', () => {
  const withUsage = (input: number, cacheRead: number, cacheCreation = 0) =>
    new AIMessage({
      content: 'Hello!',
      usage_metadata: { input_tokens: input, output_tokens: 12, total_tokens: input + 12, input_token_details: { cache_read: cacheRead, cache_creation: cacheCreation } },
    });

  it('computes the hit rate from tokens that already include the cache', () => {
    expect(usageOf(withUsage(5000, 4000, 200))).toEqual({ input: 5000, output: 12, cacheRead: 4000, cacheCreation: 200, cacheHitRate: 0.8 });
    expect(usageOf(new AIMessage('no usage'))).toBeNull();
  });

  it('puts usage on the model span and in the AGENT_MODEL_USAGE log line', async () => {
    const info = vi.spyOn(logger, 'info');
    await run([withUsage(5000, 4000)]);
    const modelSpan = memory.getFinishedSpans().find((s) => s.name === 'chat claude-sonnet-5-5')!;
    expect(modelSpan.attributes).toMatchObject({ 'gen_ai.request.model': 'claude-sonnet-5-5', 'agent.effort': 'low', 'gen_ai.usage.input_tokens': 5000, 'agent.cache_hit_rate': 0.8 });
    expect(info).toHaveBeenCalledWith('AGENT_MODEL_USAGE', expect.objectContaining({ model: 'claude-sonnet-5-5', cacheRead: 4000, cacheHitRate: 0.8 }));
  });

  it('logs no usage when the response has none', async () => {
    const info = vi.spyOn(logger, 'info');
    info.mockClear();
    await run([new AIMessage('Hello!')]);
    expect(info.mock.calls.some(([event]) => event === 'AGENT_MODEL_USAGE')).toBe(false);
  });
});

describe('log lines name their trace', () => {
  it('adds the active trace and span ids, and nothing outside a span', () => {
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('request', (span) => {
      const line = withTraceIds().transform({ level: 'info', message: 'x' }) as Record<string, unknown>;
      expect(line.traceId).toBe(span.spanContext().traceId);
      expect(line.spanId).toBe(span.spanContext().spanId);
      span.end();
    });
    const outside = withTraceIds().transform({ level: 'info', message: 'x' }) as Record<string, unknown>;
    expect(outside.traceId).toBeUndefined();
  });
});
