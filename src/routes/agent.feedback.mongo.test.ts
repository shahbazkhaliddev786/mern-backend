// Spec 021 over HTTP, against MongoDB: the reply id on `done`, thumbs up/down on a reply, and
// sampling of finished turns for the online judge.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type RequestHandler } from 'express';
import { AIMessage } from '@langchain/core/messages';
import mongoose from 'mongoose';

const { CARD } = vi.hoisted(() => ({ CARD: '4242 4242 4242 4242' }));
// Stand-in tools: the endpoint is under test, not the store. The search result carries a card
// number, which must never reach a stored snapshot.
vi.mock('../agent/tools/index.js', async () => {
  const { recordingTool } = await import('../agent/test-utils');
  const search = recordingTool('search_products', { results: [{ name: 'Blue Glazed Mug', price: 24 }], note: `card ${CARD}` });
  const clear = recordingTool('clear_cart', { items: [] }, { kind: 'write', confirmRequired: true });
  return { buildToolsForRequest: () => [search.tool, clear.tool], summarizeConfirmation: async () => 'Remove everything from your cart?' };
});

import config from '../config/config';
import { memoryLimiters, ScriptedChatModel, toolCall } from '../agent/test-utils';
import { setAgentLimiters } from '../agent/limits';
import { createCheckpointer, claimConfirmation } from '../agent/checkpointer';
import { feedbackRecords, turnSamples, type TurnSample } from '../agent/online-evals';
import type { ChatDeps } from '../agent/chat.service';
import { createAgentRouter } from './agent.routes';

const testAuth: RequestHandler = (req, res, next) => {
  const id = req.headers['x-test-user'];
  if (!id) return res.status(401).json({ status: 'error', message: 'Access denied.' });
  (req as unknown as { user: unknown }).user = { _id: String(id) };
  next();
};

let model = new ScriptedChatModel([]);
let sampleRate = 0;
let saveSample: ChatDeps['saveSample'];
const deps: ChatDeps = {
  createModel: () => model,
  createCheckpointer: () => createCheckpointer(),
  claimConfirmation: (id, thread) => claimConfirmation(id, thread),
  get sampleRate() {
    return sampleRate;
  },
  get saveSample() {
    return saveSample;
  },
} as ChatDeps;

let base = '';
let server: http.Server;

const post = (path: string, body: unknown, user?: string) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) });
async function chat(message: string, user = 'alice', threadId?: string) {
  const text = await (await post('/chat', { message, ...(threadId ? { threadId } : {}) }, user)).text();
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') as Record<string, string> }));
  return { events, done: events.find((e) => e.event === 'done')!.data };
}
const feedback = (body: Record<string, unknown>, user = 'alice') => post('/feedback', body, user);

describe.skipIf(!process.env.MONGO_URL)('agent feedback and sampling (spec 021)', () => {
  beforeAll(async () => {
    await mongoose.connect(`${process.env.MONGO_URL}/agent_feedback_test`);
    await mongoose.connection.dropDatabase();
    const app = express();
    app.use(express.json());
    app.use('/agent', createAgentRouter({ deps, auth: testAuth }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agent`;
  });
  afterAll(async () => {
    server?.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    Object.assign(config, { AGENT_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key', VOYAGE_API_KEY: 'test-voyage-key', LANGSMITH_TRACING: 'false' });
    setAgentLimiters(memoryLimiters());
    sampleRate = 0;
    saveSample = async (sample) => {
      const { saveTurnSample } = await import('../agent/online-evals');
      await saveTurnSample(sample);
    };
    await turnSamples().deleteMany({});
    await feedbackRecords().deleteMany({});
  });

  describe('the reply id on done', () => {
    it('names the reply the customer saw, as stored in the checkpoint', async () => {
      model = new ScriptedChatModel([toolCall('search_products', { query: 'blue mug' }), new AIMessage('The Blue Glazed Mug is $24.')]);
      const { done } = await chat('blue mugs?');
      expect(done.replyId).toBeTruthy();
      expect((await feedback({ threadId: done.threadId, replyId: done.replyId, rating: 'up' })).status).toBe(200);
    });

    it('is left out while a confirmation waits, and after a failure', async () => {
      model = new ScriptedChatModel([toolCall('clear_cart'), new AIMessage('Cleared.')]);
      const paused = await chat('clear my cart');
      expect(paused.events.map((e) => e.event)).toEqual(['confirm_required', 'done']);
      expect(paused.done.replyId).toBeUndefined();

      model = new ScriptedChatModel([]);
      vi.spyOn(model, '_generate').mockRejectedValueOnce(Object.assign(new Error('overloaded'), { status: 529 }));
      const failed = await chat('hi');
      expect(failed.done.replyId).toBeUndefined();
    });
  });

  describe('POST /agent/feedback', () => {
    const answered = async (user = 'alice') => {
      model = new ScriptedChatModel([toolCall('search_products', { query: 'blue mug' }), new AIMessage('The Blue Glazed Mug is $24.')]);
      return (await chat('blue mugs?', user)).done;
    };

    it('stores a vote, and a changed vote replaces it (a thumbs-down keeps a redacted snapshot)', async () => {
      const { threadId, replyId } = await answered();
      expect((await feedback({ threadId, replyId, rating: 'up' })).status).toBe(200);
      expect(await feedbackRecords().find({}).toArray()).toMatchObject([{ userId: 'alice', threadId, replyId, rating: 'up' }]);

      const down = await feedback({ threadId, replyId, rating: 'down', reason: 'wrong_answer', comment: 'That mug is out of stock.' });
      expect(await down.json()).toEqual({ status: 'success', message: 'Thanks for the feedback' });
      const [record] = await feedbackRecords().find({}).toArray();
      expect(await feedbackRecords().countDocuments({})).toBe(1);
      expect(record).toMatchObject({ rating: 'down', reason: 'wrong_answer', comment: 'That mug is out of stock.' });
      expect(record!.snapshot).toMatchObject({ message: 'blue mugs?', reply: 'The Blue Glazed Mug is $24.' });
      expect(JSON.stringify(record!.snapshot)).not.toContain(CARD);
      // Kept up to 90 days for review.
      expect(record!.expiresAt.getTime() - record!.updatedAt.getTime()).toBe(90 * 24 * 60 * 60 * 1000);

      await feedback({ threadId, replyId, rating: 'up' });
      const [changed] = await feedbackRecords().find({}).toArray();
      expect(changed).toMatchObject({ rating: 'up' });
      expect(changed).not.toHaveProperty('snapshot');
      expect(changed).not.toHaveProperty('comment');
    });

    it("can't rate another customer's reply, or a reply that doesn't exist", async () => {
      const { threadId, replyId } = await answered('alice');
      expect((await feedback({ threadId, replyId, rating: 'down' }, 'mallory')).status).toBe(404);
      expect((await feedback({ threadId, replyId: 'not-a-reply', rating: 'up' })).status).toBe(404);
      expect(await feedbackRecords().countDocuments({})).toBe(0);
    });

    it('refuses a card number in the comment, and stores nothing', async () => {
      const { threadId, replyId } = await answered();
      const response = await feedback({ threadId, replyId, rating: 'down', comment: `charge ${CARD}` });
      expect(response.status).toBe(400);
      expect(await feedbackRecords().countDocuments({})).toBe(0);
    });

    it('validates the body and needs a signed-in customer', async () => {
      const ok = { threadId: crypto.randomUUID(), replyId: 'r', rating: 'up' };
      expect((await feedback({ ...ok, rating: 'meh' })).status).toBe(400);
      expect((await feedback({ ...ok, reason: 'rude' })).status).toBe(400);
      expect((await feedback({ ...ok, comment: 'x'.repeat(301) })).status).toBe(400);
      expect((await feedback({ ...ok, threadId: 'nope' })).status).toBe(400);
      expect((await post('/feedback', ok)).status).toBe(401);
    });

    it('has its own per-user limit', async () => {
      const { threadId, replyId } = await answered();
      setAgentLimiters(memoryLimiters({ feedback: 1 }));
      expect((await feedback({ threadId, replyId, rating: 'up' })).status).toBe(200);
      const refused = await feedback({ threadId, replyId, rating: 'down' });
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBeTruthy();
    });
  });

  describe('sampling finished turns', () => {
    const turn = () => {
      model = new ScriptedChatModel([toolCall('search_products', { query: 'blue mug' }), new AIMessage('The Blue Glazed Mug is $24.')]);
      return chat('blue mugs?');
    };

    it('saves every finished turn at rate 1, redacted, under a hashed user', async () => {
      sampleRate = 1;
      const { done } = await turn();
      const samples = await turnSamples().find({}).toArray();
      expect(samples).toHaveLength(1);
      const sample = samples[0] as TurnSample;
      expect(sample).toMatchObject({ threadId: done.threadId, replyId: done.replyId, outcome: 'answered', escalated: false });
      expect(sample.user).not.toBe('alice');
      expect(sample.snapshot.calls.map((c) => c.name)).toEqual(['search_products']);
      expect(JSON.stringify(sample)).not.toContain(CARD);
      expect(sample.judgedAt).toBeUndefined();
    });

    it('saves nothing at rate 0, or while a confirmation waits', async () => {
      await turn();
      sampleRate = 1;
      model = new ScriptedChatModel([toolCall('clear_cart'), new AIMessage('Cleared.')]);
      await chat('clear my cart');
      expect(await turnSamples().countDocuments({})).toBe(0);
    });

    it('a failing insert never affects the turn', async () => {
      sampleRate = 1;
      saveSample = async () => {
        throw new Error('database down');
      };
      const { events } = await turn();
      expect(events.map((e) => e.event)).toEqual(['tool_start', 'tool_end', 'token', 'done']);
    });
  });
});
