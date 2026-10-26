// One trace for a checkout turn (spec 017, M6's exit criterion): HTTP → agent.turn → model call →
// place_order → MongoDB, with the real agent router, tools and database. Stripe and the model are
// stand-ins. Runs only when MONGO_URL is set.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { tracing as sdkTracing } from '@opentelemetry/sdk-node';

vi.mock('../config/stripe.js', () => ({
  stripeClient: { checkout: { sessions: { create: async () => ({ id: 'cs_test_trace', url: 'https://checkout.stripe.com/c/pay/cs_test_trace' }) } } },
}));

const MONGO_URL = process.env.MONGO_URL;

describe.skipIf(!MONGO_URL)('a traced checkout turn', () => {
  let spans: () => sdkTracing.ReadableSpan[];
  let base = '';
  let userId = '';
  let close: () => Promise<void>;
  const email = 'trace.jane@example.com';

  beforeAll(async () => {
    process.env.CLOUDINARY_CLOUD_NAME ??= 'test';
    process.env.CLOUDINARY_API_KEY ??= 'test';
    process.env.CLOUDINARY_API_SECRET ??= 'test';
    // Tracing first, so the HTTP and MongoDB modules are patched before they load.
    const { tracing } = await import('@opentelemetry/sdk-node');
    const memory = new tracing.InMemorySpanExporter();
    const { startTracing } = await import('../tracing.js');
    startTracing([memory], { immediate: true });
    spans = () => memory.getFinishedSpans();

    const { default: express } = await import('express');
    const { default: mongoose } = await import('mongoose');
    const http = await import('node:http');
    const { AIMessage } = await import('@langchain/core/messages');
    const { MemorySaver } = await import('@langchain/langgraph');
    const { default: config } = await import('../config/config.js');
    const models = await import('../models/index.js');
    const { createAgentRouter } = await import('../routes/agent.routes.js');
    const { memoryLimiters, ScriptedChatModel, toolCall } = await import('./test-utils.js');
    const { setAgentLimiters } = await import('./limits.js');

    await mongoose.connect(`${MONGO_URL}/agent_tracing_test`);
    await mongoose.connection.dropDatabase();
    const user = await models.User.create({ name: 'Jane', email, password: 'secret-password', isVerified: true });
    const category = await models.Category.create({ name: 'Shoes' });
    const brand = await models.Brand.create({ name: 'Aljo' });
    const product = await models.Product.create({ name: 'Trail Runner', description: 'Trail shoe', price: 45, stock: 10, sku: 'TR-T', category: category._id, brand: brand._id });
    userId = String(user._id);
    await models.Cart.create({ user: user._id, items: [{ product: product._id, quantity: 2 }] });

    Object.assign(config, { AGENT_ENABLED: 'true', ANTHROPIC_API_KEY: 'test', VOYAGE_API_KEY: 'test' });
    setAgentLimiters(memoryLimiters());
    const address = { fullName: 'Jane Doe', address: '1 Main St', city: 'Lahore', postalCode: '54000', country: 'Pakistan' };
    const checkpointer = new MemorySaver();
    const model = new ScriptedChatModel([toolCall('place_order', { shipping_address: address }), new AIMessage('Here is your checkout link.')]);
    const app = express();
    app.use(express.json());
    app.use(
      '/agent',
      createAgentRouter({
        deps: { createModel: () => model, createCheckpointer: () => checkpointer, claimConfirmation: async () => true },
        auth: (req, _res, next) => {
          (req as unknown as { user: unknown }).user = { _id: userId, email };
          next();
        },
      }),
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/agent/chat`;
    close = async () => {
      server.close();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    };
  }, 60_000);

  afterAll(async () => {
    await close?.();
    const { stopTracing } = await import('../tracing.js');
    await stopTracing();
  });

  const send = async (body: unknown) => {
    const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    const events = text.split('\n\n').filter(Boolean).map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null') }));
    return events;
  };

  it('shows the whole confirmed checkout in one trace', async () => {
    const first = await send({ message: 'check out please' });
    const confirm = first.find((e) => e.event === 'confirm_required')!.data;
    const threadId = first.at(-1)!.data.threadId as string;
    const before = spans().length;
    await send({ threadId, resume: { interruptId: confirm.interruptId, approved: true } });
    // The handler flushed before ending the response; the HTTP span ends just after, so flush again.
    const { flushTraces } = await import('../tracing.js');
    await flushTraces();

    const turn = spans().slice(before);
    const server = turn.find((s) => s.name === 'POST /agent/chat')!;
    expect(server).toBeDefined();
    const traceId = server.spanContext().traceId;
    const inTrace = turn.filter((s) => s.spanContext().traceId === traceId);
    const byId = new Map(inTrace.map((s) => [s.spanContext().spanId, s]));
    const parentOf = (s: sdkTracing.ReadableSpan) => byId.get(s.parentSpanContext?.spanId ?? '');

    const agentTurn = inTrace.find((s) => s.name === 'agent.turn')!;
    const tool = inTrace.find((s) => s.name === 'tool place_order')!;
    const model = inTrace.find((s) => s.name === 'chat claude-sonnet-5-5')!;
    const queries = inTrace.filter((s) => s.instrumentationScope.name === '@opentelemetry/instrumentation-mongodb' && parentOf(s) === tool);

    expect(parentOf(agentTurn)).toBe(server);
    expect(parentOf(tool)).toBe(agentTurn);
    expect(parentOf(model)).toBe(agentTurn);
    expect(queries.length).toBeGreaterThan(0);
    expect(tool.attributes).toMatchObject({ 'gen_ai.tool.name': 'place_order', 'agent.tool_ok': true, 'agent.confirm_required': true });
    expect(agentTurn.attributes).toMatchObject({ 'agent.kind': 'resume', 'agent.outcome': 'answered', 'agent.tool_calls': 1, 'agent.escalated': false });

    // Ids and counts only: no raw user id, email, address or query values anywhere.
    const attributes = JSON.stringify(inTrace.map((s) => s.attributes));
    for (const secret of [userId, email, 'Lahore', '1 Main St']) expect(attributes).not.toContain(secret);
    // The query's shape is kept for debugging; every value in it is masked as "?".
    const leaves = (node: unknown): unknown[] =>
      node && typeof node === 'object' ? Object.values(node as Record<string, unknown>).flatMap(leaves) : [node];
    for (const query of queries) {
      const shape = JSON.parse(String(query.attributes['db.query.text'] ?? '{}')) as unknown;
      expect(leaves(shape).every((value) => value === '?')).toBe(true);
    }
  });

  it('records the pause for confirmation as the first turn\'s outcome', () => {
    const paused = spans().find((s) => s.name === 'agent.turn' && s.attributes['agent.kind'] === 'message');
    expect(paused?.attributes['agent.outcome']).toBe('confirm_required');
  });
});
