// I6 race, tightened: process start-up jitter (~1s for tsx) means two separate processes
// rarely overlap. Here each "request" gets its own MongoClient, checkpointer and compiled
// graph (nothing shared but MongoDB), and both resumes fire on the same tick.
//
//   npx tsx spikes/002-interrupt-resume/race.ts [rounds]   → prints one JSON line

import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { MongoClient } from 'mongodb';
import { buildGraph } from './graph.ts';

const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = 'spike_002';
const ROUNDS = Number(process.argv[2] ?? 20);

async function independentRequest() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const graph = buildGraph(db, new MongoDBSaver({ client, dbName: DB_NAME }));
  return { client, db, graph };
}

type Req = Awaited<ReturnType<typeof independentRequest>>;

async function guardedResume(req: Req, threadId: string): Promise<string> {
  const config = { configurable: { thread_id: threadId } };
  const interruptId = (await req.graph.getState(config)).tasks.flatMap((t) => t.interrupts)[0]?.id;
  if (!interruptId) return 'nothing pending';
  try {
    await req.db.collection<{ _id: string; threadId: string }>('spike_confirm_claims').insertOne({ _id: interruptId, threadId });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return 'already confirmed';
    throw error;
  }
  await req.graph.invoke(new Command({ resume: { approved: true } }), config);
  return 'resumed';
}

async function main() {
  const [a, b] = await Promise.all([independentRequest(), independentRequest()]);
  const effects = (threadId: string) => a.db.collection('spike_effects').countDocuments({ threadId });
  const tally = { unguarded: [] as number[], guarded: [] as number[], guardedReplies: {} as Record<string, number> };

  for (let i = 0; i < ROUNDS; i += 1) {
    const t = `t-race2-${i}`;
    await a.graph.invoke({ messages: [new HumanMessage('Clear my cart.')] }, { configurable: { thread_id: t } });
    await Promise.allSettled([
      a.graph.invoke(new Command({ resume: { approved: true } }), { configurable: { thread_id: t } }),
      b.graph.invoke(new Command({ resume: { approved: true } }), { configurable: { thread_id: t } }),
    ]);
    tally.unguarded.push(await effects(t));

    const g = `t-race2-guarded-${i}`;
    await a.graph.invoke({ messages: [new HumanMessage('Clear my cart.')] }, { configurable: { thread_id: g } });
    const replies = await Promise.all([guardedResume(a, g), guardedResume(b, g)]);
    for (const r of replies) tally.guardedReplies[r] = (tally.guardedReplies[r] ?? 0) + 1;
    tally.guarded.push(await effects(g));
  }

  const count = (xs: number[], n: number) => xs.filter((x) => x === n).length;
  process.stdout.write(
    `${JSON.stringify({
      rounds: ROUNDS,
      unguarded: { ranOnce: count(tally.unguarded, 1), ranTwice: count(tally.unguarded, 2), other: tally.unguarded.filter((x) => x !== 1 && x !== 2).length },
      guarded: { ranOnce: count(tally.guarded, 1), ranTwice: count(tally.guarded, 2), replies: tally.guardedReplies },
    })}\n`,
  );
  await Promise.all([a.client.close(), b.client.close()]);
}

await main();
