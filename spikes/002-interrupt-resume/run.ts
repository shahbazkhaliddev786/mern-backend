// Spec 002 runner. Every "request" is a separate process (request.ts); this file only
// starts them and counts side effects in MongoDB. Usage (from mern-backend/, MongoDB up):
//   npx tsx spikes/002-interrupt-resume/run.ts
// Writes results.md next to this file.

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = 'spike_002';
const run = promisify(execFile);

interface Reply {
  ok: boolean;
  error?: string;
  out?: { interrupt?: { id: string; value: unknown }[] | null; lastMessage?: { type?: string; content?: unknown }; chunks?: unknown[] };
  next?: string[];
  connectedMs?: number;
  totalMs?: number;
}

async function request(action: string, threadId: string, client = 'mongoose'): Promise<Reply> {
  const { stdout } = await run('npx', ['tsx', 'spikes/002-interrupt-resume/request.ts', action, threadId, '--client', client], { cwd: root });
  const line = stdout.trim().split('\n').at(-1) ?? '{}';
  return JSON.parse(line) as Reply;
}

type Verdict = 'pass' | 'fail' | 'finding';
interface Row {
  id: string;
  name: string;
  verdict: Verdict;
  evidence: string;
}

const rows: Row[] = [];
const record = (id: string, name: string, pass: boolean | 'finding', evidence: string) =>
  rows.push({ id, name, verdict: pass === 'finding' ? 'finding' : pass ? 'pass' : 'fail', evidence });
const j = (v: unknown) => JSON.stringify(v);

async function main() {
  const mongo = new MongoClient(MONGO_URL);
  await mongo.connect();
  const db = mongo.db(DB_NAME);
  await db.dropDatabase();
  const effects = (threadId: string) => db.collection('spike_effects').countDocuments({ threadId });
  const gateEntries = (threadId: string) => db.collection('spike_gate_entries').countDocuments({ threadId });

  const setup = await request('setup', '-');
  if (!setup.ok) throw new Error(`setup failed: ${setup.error}`);

  // I1 + I2 + I4, with both clients (I9a)
  for (const client of ['mongoose', 'own']) {
    const t = `t-approve-${client}`;
    const a = await request('start', t, client);
    const effectsAfterPause = await effects(t);
    const interrupt = a.out?.interrupt?.[0];
    record(
      'I1',
      `Pause (${client} client)`,
      a.ok && (interrupt?.value as { tool?: string })?.tool === 'clear_cart' && effectsAfterPause === 0 && j(a.next) === j(['gate']),
      `interrupt=${j(interrupt?.value)} next=${j(a.next)} effects=${effectsAfterPause} ${a.error ?? ''}`,
    );
    const b = await request('resume-yes', t, client);
    const effectsAfterResume = await effects(t);
    record(
      'I2',
      `Resume approved in another process (${client} client)`,
      b.ok && effectsAfterResume === 1 && b.out?.lastMessage?.content === 'Done — your cart is empty.' && j(b.next) === j([]),
      `effects=${effectsAfterResume} last=${j(b.out?.lastMessage)} next=${j(b.next)} resume took ${b.totalMs}ms (connect ${b.connectedMs}ms) ${b.error ?? ''}`,
    );
    if (client === 'mongoose') {
      record('I4', 'Gate node re-entry', 'finding', `gate node started ${await gateEntries(t)} times for one confirmation (pause + resume)`);

      // I5: the same confirm again, after the turn finished
      const again = await request('resume-yes', t, client);
      record(
        'I5',
        'Duplicate confirm, sequential',
        (await effects(t)) === 1,
        `second resume: ok=${again.ok} last=${j(again.out?.lastMessage)} error=${j(again.error)}; effects still ${await effects(t)}`,
      );
    }
  }

  // I3: declined
  {
    const t = 't-decline';
    await request('start', t);
    const r = await request('resume-no', t);
    record(
      'I3',
      'Resume declined',
      r.ok && (await effects(t)) === 0 && r.out?.lastMessage?.content === 'Okay, I left your cart as it is.',
      `effects=${await effects(t)} last=${j(r.out?.lastMessage)}`,
    );
  }

  // I6: two concurrent confirms. Separate processes rarely overlap (tsx start-up jitter),
  // so race.ts fires both resumes on the same tick from fully independent clients and graphs.
  {
    const { stdout } = await run('npx', ['tsx', 'spikes/002-interrupt-resume/race.ts', '20'], { cwd: root });
    const race = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      rounds: number;
      unguarded: { ranOnce: number; ranTwice: number };
      guarded: { ranOnce: number; ranTwice: number; replies: Record<string, number> };
    };
    record(
      'I6',
      'Duplicate confirm, concurrent (no guard)',
      race.unguarded.ranTwice === 0 ? true : 'finding',
      `${race.rounds} rounds: tool ran twice in ${race.unguarded.ranTwice}, once in ${race.unguarded.ranOnce}`,
    );
    record(
      'I6',
      'Duplicate confirm, concurrent (claim guard)',
      race.guarded.ranOnce === race.rounds,
      `${race.rounds} rounds: tool ran once in ${race.guarded.ranOnce}, twice in ${race.guarded.ranTwice}; replies=${j(race.guarded.replies)}`,
    );
  }

  // I7: nothing pending / unknown thread
  {
    const unknown = await request('resume-yes', 't-never-started');
    const guardedUnknown = await request('resume-yes-guarded', 't-never-started');
    record(
      'I7',
      'Resume with nothing pending',
      'finding',
      `unknown thread, plain resume: ok=${unknown.ok} last=${j(unknown.out?.lastMessage)} next=${j(unknown.next)} error=${j(unknown.error)} effects=${await effects('t-never-started')}; with claim guard: ${j(guardedUnknown.error ?? 'resumed')}`,
    );
  }

  // I8: streaming
  {
    const t = 't-stream';
    const a = await request('stream-start', t);
    const b = await request('stream-resume-yes', t);
    const aChunks = (a.out?.chunks ?? []) as { mode: string; keys: string[]; interrupt?: unknown; text?: unknown }[];
    const bChunks = (b.out?.chunks ?? []) as { mode: string; keys: string[]; interrupt?: unknown; text?: unknown }[];
    const interruptChunk = aChunks.find((c) => c.keys.includes('__interrupt__'));
    const toolMsg = bChunks.some((c) => c.mode === 'messages' && c.keys.includes('tool'));
    const finalText = bChunks.some((c) => c.mode === 'messages' && c.text === 'Done — your cart is empty.');
    record(
      'I8',
      'Pause and resume while streaming',
      Boolean(interruptChunk) && toolMsg && finalText && (await effects(t)) === 1,
      `start: ${j(aChunks.map((c) => `${c.mode}:${c.keys.join('+')}`))} interrupt chunk=${j(interruptChunk?.interrupt)}; resume: ${j(bChunks.map((c) => `${c.mode}:${c.keys.join('+')}`))} effects=${await effects(t)}`,
    );
  }

  // I9b/c: TTL indexes and checkpoint size
  {
    const describe = async (name: string) =>
      (await db.collection(name).indexes()).map((i) => `${j(i.key)}${i.expireAfterSeconds !== undefined ? ` ttl=${i.expireAfterSeconds}s` : ''}`);
    const cp = await describe('checkpoints');
    const cw = await describe('checkpoint_writes');
    const ttlOk = cp.some((i) => i.includes('ttl=2592000')) && cw.some((i) => i.includes('ttl=2592000'));
    record('I9', 'TTL indexes from setup()', ttlOk, `checkpoints: ${cp.join(', ')} | checkpoint_writes: ${cw.join(', ')}`);

    const size = async (name: string, threadId: string) => {
      const [agg] = await db
        .collection(name)
        .aggregate<{ docs: number; bytes: number }>([
          { $match: { thread_id: threadId } },
          { $group: { _id: null, docs: { $sum: 1 }, bytes: { $sum: { $bsonSize: '$$ROOT' } } } },
        ])
        .toArray();
      return agg ?? { docs: 0, bytes: 0 };
    };
    const a = await size('checkpoints', 't-approve-mongoose');
    const b = await size('checkpoint_writes', 't-approve-mongoose');
    const sample = await db.collection('checkpoints').findOne({ thread_id: 't-approve-mongoose' });
    record(
      'I9',
      'Checkpoint size for one confirmed turn',
      'finding',
      `checkpoints: ${a.docs} docs / ${a.bytes} bytes; checkpoint_writes: ${b.docs} docs / ${b.bytes} bytes; upserted_at present=${Boolean(sample?.upserted_at)}`,
    );
  }

  await mongo.close();

  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    '# Spec 002 results',
    '',
    `Run: ${new Date().toISOString()} · MongoDB ${MONGO_URL.replace(/\/\/[^@]*@/, '//***@')} · every request in its own process`,
    '',
    '| Check | Result | Evidence |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.id} ${r.name} | ${r.verdict} | ${cell(r.evidence)} |`),
    '',
  ].join('\n');
  writeFileSync(path.join(here, 'results.md'), md);
  process.stdout.write(`${md}\nWrote ${path.relative(root, path.join(here, 'results.md'))}\n`);
  if (rows.some((r) => r.verdict === 'fail')) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
