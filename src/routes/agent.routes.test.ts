import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import mongoose from 'mongoose';

// The real tools need MongoDB; these tests check the endpoint, so stand-in tools are enough.
const fakeTools = vi.hoisted(() => ({ runs: [] as unknown[], clearRuns: [] as unknown[] }));
vi.mock('../agent/tools/index.js', async () => {
  const { recordingTool } = await import('../agent/test-utils');
  const search = recordingTool('search_products', { results: [{ name: 'Trail Runner', price: 45 }] });
  const clear = recordingTool('clear_cart', { items: [], itemsCount: 0 }, { kind: 'write', confirmRequired: true });
  fakeTools.runs = search.runs;
  fakeTools.clearRuns = clear.runs;
  return {
    buildToolsForRequest: () => [search.tool, clear.tool],
    summarizeConfirmation: async () => 'Remove all 2 items ($90.00) from your cart?',
  };
});

import config from '../config/config';
import { ScriptedChatModel, toolCall } from '../agent/test-utils';
import { createAgentRouter } from './agent.routes';

// Stand-in for a verified session: x-test-user carries the user id.
const testAuth: RequestHandler = (req, res, next) => {
  const id = req.headers['x-test-user'];
  if (!id) return res.status(401).json({ status: 'error', message: 'Access denied. No token provided.' });
  (req as any).user = { _id: String(id), name: 'Test User', email: 'test@example.com' }; // eslint-disable-line @typescript-eslint/no-explicit-any -- test stand-in for the session
  next();
};

let model: ScriptedChatModel;
let checkpointer: MemorySaver | ReturnType<typeof import('../agent/checkpointer').createCheckpointer> = new MemorySaver();
// In memory by default; the MongoDB block swaps in the real claim.
let claimed = new Set<string>();
let claim = async (interruptId: string) => (claimed.has(interruptId) ? false : (claimed.add(interruptId), true));
const deps = {
  createModel: () => model,
  createCheckpointer: () => checkpointer,
  claimConfirmation: (interruptId: string, thread: string) => claim(interruptId, thread),
};

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => server.listen(0, () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

const servers: http.Server[] = [];
async function start(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/agent', router);
  const server = http.createServer(app);
  servers.push(server);
  return `${await listen(server)}/agent/chat`;
}

let withTestAuth = '';
let withRealAuth = '';
let withProbe = '';

beforeAll(async () => {
  withTestAuth = await start(createAgentRouter({ deps, auth: testAuth }));
  withRealAuth = await start(createAgentRouter({ deps }));
  withProbe = await start(createAgentRouter({ deps, auth: testAuth, streamProbeEnabled: true }));
});
afterAll(() => servers.forEach((server) => server.close()));

beforeEach(() => {
  config.AGENT_ENABLED = 'true';
  config.ANTHROPIC_API_KEY = 'test-key';
  config.LANGSMITH_TRACING = 'false';
  checkpointer = new MemorySaver();
  claimed = new Set();
  claim = async (interruptId: string) => (claimed.has(interruptId) ? false : (claimed.add(interruptId), true));
  fakeTools.runs.length = 0;
  fakeTools.clearRuns.length = 0;
});

const post = (url: string, body: unknown, user?: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body),
  });

/** Reads an SSE body into [{ event, data }]. */
async function readEvents(response: Response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

describe('POST /agent/chat — availability and input', () => {
  it('answers 503 while the agent is switched off', async () => {
    config.AGENT_ENABLED = 'false';
    const response = await post(withTestAuth, { message: 'hi' }, 'u1');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'error', message: 'The shopping assistant is not available right now.' });
  });

  it('answers 503 when switched on without a key, without naming the missing variable', async () => {
    config.ANTHROPIC_API_KEY = '';
    const response = await post(withTestAuth, { message: 'hi' }, 'u1');
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('ANTHROPIC');
  });

  it('answers 401 without a token (real auth middleware)', async () => {
    expect((await post(withRealAuth, { message: 'hi' })).status).toBe(401);
  });

  it('answers 400 for an empty message, an over-long one or a bad threadId', async () => {
    expect((await post(withTestAuth, { message: '  ' }, 'u1')).status).toBe(400);
    expect((await post(withTestAuth, { message: 'x'.repeat(2001) }, 'u1')).status).toBe(400);
    expect((await post(withTestAuth, { message: 'hi', threadId: 'not-a-uuid' }, 'u1')).status).toBe(400);
  });
});

describe('POST /agent/chat — streaming a turn', () => {
  it('streams tool_start, tool_end, the answer and done', async () => {
    model = new ScriptedChatModel([toolCall('search_products', { query: 'shoes' }), new AIMessage('Trail Runner is $45.')]);
    const response = await post(withTestAuth, { message: 'shoes under $50?' }, 'u1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const events = await readEvents(response);
    expect(events.map((e) => e.event)).toEqual(['tool_start', 'tool_end', 'token', 'done']);
    expect(events[0]!.data).toEqual({ tool: 'search_products', label: 'Searching products…' });
    expect(events[1]!.data).toEqual({ tool: 'search_products', ok: true });
    expect(events[2]!.data).toEqual({ text: 'Trail Runner is $45.' });
    expect(events[3]!.data.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fakeTools.runs).toEqual([{ query: 'shoes' }]);
  });

  it('streams an error event and still ends with done when the model fails', async () => {
    model = new ScriptedChatModel([]);
    vi.spyOn(model, '_generate').mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));
    const events = await readEvents(await post(withTestAuth, { message: 'hi' }, 'u1'));
    expect(events.map((e) => e.event)).toEqual(['error', 'done']);
    expect(events[0]!.data).toEqual({ message: 'The assistant is busy right now. Please try again in a moment.', retryable: true });
  });
});

describe('POST /agent/chat — confirmation (spec 008)', () => {
  /** Starts a turn whose model asks to clear the cart; returns the threadId and the pending interrupt. */
  async function pauseOnClearCart(user = 'u1') {
    const events = await readEvents(await post(withTestAuth, { message: 'empty my cart' }, user));
    const confirm = events.find((e) => e.event === 'confirm_required');
    return { events, threadId: events.at(-1)!.data.threadId as string, interruptId: confirm?.data.interruptId as string, confirm };
  }
  const resume = (threadId: string, interruptId: string, approved: boolean, user = 'u1') =>
    post(withTestAuth, { threadId, resume: { interruptId, approved } }, user);

  it('pauses with confirm_required (no tool_start yet) and runs nothing', async () => {
    model = new ScriptedChatModel([toolCall('clear_cart')]);
    const { events, confirm } = await pauseOnClearCart();
    expect(events.map((e) => e.event)).toEqual(['confirm_required', 'done']);
    expect(confirm!.data).toMatchObject({ tool: 'clear_cart', summary: 'Remove all 2 items ($90.00) from your cart?' });
    expect(confirm!.data.interruptId).toBeTruthy();
    expect(fakeTools.clearRuns).toHaveLength(0);
  });

  it('runs the tool once on confirm, and a second confirm gets "already confirmed"', async () => {
    model = new ScriptedChatModel([toolCall('clear_cart'), new AIMessage('Your cart is empty now.')]);
    const { threadId, interruptId } = await pauseOnClearCart();

    const confirmed = await readEvents(await resume(threadId, interruptId, true));
    expect(confirmed.map((e) => e.event)).toEqual(['tool_start', 'tool_end', 'token', 'done']);
    expect(confirmed[0]!.data).toEqual({ tool: 'clear_cart', label: 'Clearing your cart…' });
    expect(fakeTools.clearRuns).toHaveLength(1);

    const again = await readEvents(await resume(threadId, interruptId, true));
    expect(again.map((e) => e.event)).toEqual(['error', 'done']);
    expect(again[0]!.data).toEqual({ message: "There's nothing waiting for confirmation.", retryable: false });
    expect(fakeTools.clearRuns).toHaveLength(1);
  });

  it('declining never runs the tool', async () => {
    model = new ScriptedChatModel([toolCall('clear_cart'), new AIMessage('Okay, I left your cart as it is.')]);
    const { threadId, interruptId } = await pauseOnClearCart();
    const declined = await readEvents(await resume(threadId, interruptId, false));
    expect(declined.map((e) => e.event)).toEqual(['token', 'done']);
    expect(fakeTools.clearRuns).toHaveLength(0);
  });

  it('an interrupt already claimed elsewhere gets "already confirmed"', async () => {
    model = new ScriptedChatModel([toolCall('clear_cart')]);
    const { threadId, interruptId } = await pauseOnClearCart();
    claimed.add(interruptId); // as if another request won the claim a moment earlier
    const events = await readEvents(await resume(threadId, interruptId, true));
    expect(events[0]!.data).toEqual({ message: 'That was already confirmed.', retryable: false });
    expect(fakeTools.clearRuns).toHaveLength(0);
  });

  it('a wrong interrupt id, or another user\'s thread, finds nothing waiting', async () => {
    model = new ScriptedChatModel([toolCall('clear_cart')]);
    const { threadId, interruptId } = await pauseOnClearCart('alice');
    const wrongId = await readEvents(await resume(threadId, 'not-the-id', true, 'alice'));
    expect(wrongId[0]!.data.message).toBe("There's nothing waiting for confirmation.");
    const otherUser = await readEvents(await resume(threadId, interruptId, true, 'mallory'));
    expect(otherUser[0]!.data.message).toBe("There's nothing waiting for confirmation.");
    expect(fakeTools.clearRuns).toHaveLength(0);
  });

  it('rejects a malformed resume body with 400', async () => {
    expect((await post(withTestAuth, { resume: { interruptId: 'x', approved: true } }, 'u1')).status).toBe(400); // no threadId
    expect((await post(withTestAuth, { threadId: crypto.randomUUID(), resume: { interruptId: 'x', approved: 'yes' } }, 'u1')).status).toBe(400);
  });
});

// Conversation memory and thread ownership need the real checkpointer (MongoDB).
describe.skipIf(!process.env.MONGO_URL)('POST /agent/chat — memory in MongoDB', () => {
  beforeAll(async () => {
    await mongoose.connect(`${process.env.MONGO_URL}/agent_chat_test`);
    await mongoose.connection.dropDatabase();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  const humanTexts = (call: BaseMessage[]) => call.filter((m) => m instanceof HumanMessage).map((m) => m.content);

  it('two concurrent confirms run clear_cart once (real confirm_claims claim)', async () => {
    const { createCheckpointer, claimConfirmation } = await import('../agent/checkpointer');
    claim = claimConfirmation;
    checkpointer = createCheckpointer();
    model = new ScriptedChatModel([toolCall('clear_cart'), new AIMessage('Your cart is empty now.'), new AIMessage('Your cart is empty now.')]);
    const first = await readEvents(await post(withTestAuth, { message: 'empty my cart' }, 'carol'));
    const threadId = first.at(-1)!.data.threadId as string;
    const interruptId = first.find((e) => e.event === 'confirm_required')!.data.interruptId as string;

    const both = await Promise.all(
      [1, 2].map(async () => readEvents(await post(withTestAuth, { threadId, resume: { interruptId, approved: true } }, 'carol'))),
    );
    expect(fakeTools.clearRuns).toHaveLength(1);
    const errors = both.flat().filter((e) => e.event === 'error').map((e) => e.data.message);
    expect(errors).toHaveLength(1);
    expect(['That was already confirmed.', "There's nothing waiting for confirmation."]).toContain(errors[0]);
  });

  it('remembers the conversation per thread, and a thread id never opens another user\'s history', async () => {
    const { createCheckpointer } = await import('../agent/checkpointer');
    model = new ScriptedChatModel([new AIMessage('Hi Alice!'), new AIMessage('You said your name is Alice.'), new AIMessage('Hello!')]);

    checkpointer = createCheckpointer();
    const first = await readEvents(await post(withTestAuth, { message: 'I am Alice' }, 'alice'));
    const threadId = first.at(-1)!.data.threadId as string;

    checkpointer = createCheckpointer(); // a new request builds a new checkpointer
    await readEvents(await post(withTestAuth, { message: 'What is my name?', threadId }, 'alice'));
    expect(humanTexts(model.calls[1]!)).toEqual(['I am Alice', 'What is my name?']);

    checkpointer = createCheckpointer();
    await readEvents(await post(withTestAuth, { message: 'Show me the chat', threadId }, 'mallory'));
    expect(humanTexts(model.calls[2]!)).toEqual(['Show me the chat']);
  });
});

// TEMPORARY (spec 004): the streaming probe.
describe('POST /agent/_stream-probe', () => {
  const probeUrl = (base: string, seconds: string) => base.replace(/\/chat$/, `/_stream-probe?seconds=${seconds}`);

  it('does not exist unless switched on', async () => {
    expect((await fetch(probeUrl(withTestAuth, '2'), { method: 'POST' })).status).toBe(404);
  });

  it('streams one tick per second, then done', async () => {
    const started = Date.now();
    const response = await fetch(probeUrl(withProbe, '2'), { method: 'POST' });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const events = await readEvents(response);
    const named = events.filter((e) => e.event);
    expect(named.map((e) => e.event)).toEqual(['tick', 'tick', 'done']);
    expect(named[1]!.data.i).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });

  it('rejects a duration outside 1-300 seconds', async () => {
    expect((await fetch(probeUrl(withProbe, '0'), { method: 'POST' })).status).toBe(400);
    expect((await fetch(probeUrl(withProbe, '301'), { method: 'POST' })).status).toBe(400);
    expect((await fetch(probeUrl(withProbe, 'abc'), { method: 'POST' })).status).toBe(400);
  });
});
