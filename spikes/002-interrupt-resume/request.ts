// One "request" for spec 002: a fresh process with its own MongoDB client, checkpointer
// and compiled graph. It makes one graph call, prints one JSON line, and exits.
//
//   npx tsx spikes/002-interrupt-resume/request.ts <action> <threadId> [--client mongoose|own]
//   actions: setup | start | resume-yes | resume-no | resume-yes-guarded | stream-start | stream-resume-yes

import { createRequire } from 'node:module';
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import mongoose from 'mongoose';
import type { MongoClient } from 'mongodb';
import { buildGraph } from './graph.ts';

export const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
export const DB_NAME = 'spike_002';
export const TTL_SECONDS = 2_592_000; // 30 days (spec 002 decision log)

const [action, threadId] = process.argv.slice(2);
const clientKind = process.argv.includes('--client') ? process.argv[process.argv.indexOf('--client') + 1] : 'mongoose';

async function connect(): Promise<{ client: MongoClient; close: () => Promise<void> }> {
  if (clientKind === 'own') {
    // The checkpointer's own nested driver (6.x) — a second connection pool next to mongoose.
    const require = createRequire(import.meta.resolve('@langchain/langgraph-checkpoint-mongodb'));
    const { MongoClient: OwnClient } = require('mongodb') as typeof import('mongodb');
    const client = new OwnClient(MONGO_URL);
    await client.connect();
    return { client, close: () => client.close() };
  }
  // The app's mongoose connection (driver 7.x) — what M2 would reuse.
  await mongoose.connect(`${MONGO_URL}/${DB_NAME}`);
  return { client: mongoose.connection.getClient() as unknown as MongoClient, close: () => mongoose.disconnect() };
}

function summarize(value: unknown): unknown {
  const state = value as { messages?: { getType?: () => string; content?: unknown }[]; __interrupt__?: unknown };
  return {
    interrupt: state.__interrupt__ ?? null,
    lastMessage: state.messages?.at(-1) ? { type: state.messages.at(-1)?.getType?.(), content: state.messages.at(-1)?.content } : null,
    messageCount: state.messages?.length ?? 0,
  };
}

async function main() {
  const started = Date.now();
  const { client, close } = await connect();
  const connectedMs = Date.now() - started;
  try {
    const checkpointer = new MongoDBSaver({ client, dbName: DB_NAME, ttl: TTL_SECONDS });
    const graph = buildGraph(client.db(DB_NAME), checkpointer);
    const config = { configurable: { thread_id: threadId } };

    if (action === 'setup') {
      await checkpointer.setup();
      process.stdout.write(`${JSON.stringify({ ok: true, action })}\n`);
      return;
    }

    if (action === 'resume-yes-guarded') {
      // Claim the pending interrupt before resuming: a unique _id means only one request can win.
      const pending = (await graph.getState(config)).tasks.flatMap((task) => task.interrupts);
      const interruptId = pending[0]?.id;
      if (!interruptId) {
        process.stdout.write(`${JSON.stringify({ ok: false, action, threadId, error: 'nothing pending' })}\n`);
        return;
      }
      try {
        await client.db(DB_NAME).collection<{ _id: string; threadId: string }>('spike_confirm_claims').insertOne({ _id: interruptId, threadId });
      } catch (error) {
        if ((error as { code?: number }).code === 11000) {
          process.stdout.write(`${JSON.stringify({ ok: false, action, threadId, error: 'already confirmed' })}\n`);
          return;
        }
        throw error;
      }
    }

    const input =
      action === 'start' || action === 'stream-start'
        ? { messages: [new HumanMessage('Clear my cart.')] }
        : new Command({ resume: { approved: action.includes('-yes') } });

    let out: unknown;
    if (action.startsWith('stream-')) {
      const chunks: { mode: string; keys: string[]; interrupt?: unknown; text?: unknown }[] = [];
      for await (const [mode, chunk] of await graph.stream(input, { ...config, streamMode: ['updates', 'messages'] })) {
        if (mode === 'updates') {
          const update = chunk as Record<string, unknown>;
          chunks.push({ mode, keys: Object.keys(update), interrupt: update.__interrupt__ });
        } else {
          const [message] = chunk as [{ content?: unknown; getType?: () => string }];
          chunks.push({ mode, keys: [message?.getType?.() ?? 'unknown'], text: message?.content });
        }
      }
      out = { chunks };
    } else {
      out = summarize(await graph.invoke(input, config));
    }
    const snapshot = await graph.getState(config);
    process.stdout.write(
      `${JSON.stringify({ ok: true, action, threadId, clientKind, connectedMs, totalMs: Date.now() - started, out, next: snapshot.next })}\n`,
    );
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, action, threadId, clientKind, error: (error as Error).message.split('\n')[0] })}\n`);
  } finally {
    await close();
  }
}

if (action) await main();
