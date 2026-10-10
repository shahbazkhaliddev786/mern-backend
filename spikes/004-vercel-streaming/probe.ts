// Spec 004 probe: does a long server-sent-events response stream, or arrive in one burst?
//
//   npx tsx spikes/004-vercel-streaming/probe.ts <probe-url> [seconds] [--label R2-direct]
//   e.g. npx tsx spikes/004-vercel-streaming/probe.ts https://<backend-preview>.vercel.app/api/v1/agent/_stream-probe 90
//
// POSTs to the probe endpoint, reads the body with a ReadableStream (as the chat UI will),
// records when every event arrives, prints a summary, and appends a row to results.md.

import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [url, secondsArg] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--label');
const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : '';
const seconds = Number(secondsArg ?? 30);
if (!url) {
  process.stderr.write('Usage: npx tsx spikes/004-vercel-streaming/probe.ts <probe-url> [seconds] [--label NAME]\n');
  process.exit(1);
}

interface Arrival {
  event: string;
  atMs: number;
  data?: { i?: number; serverTs?: number; elapsedMs?: number };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

async function main() {
  const target = new URL(url!);
  target.searchParams.set('seconds', String(seconds));
  const started = performance.now();
  const at = () => Math.round(performance.now() - started);

  const arrivals: Arrival[] = [];
  let firstByteMs: number | undefined;
  let status = 0;
  let ending = 'cut off (stream closed before done)';

  try {
    const response = await fetch(target, { method: 'POST', headers: { accept: 'text/event-stream' } });
    status = response.status;
    if (!response.ok || !response.body) {
      ending = `HTTP ${status}: ${(await response.text()).slice(0, 200)}`;
    } else {
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        firstByteMs ??= at();
        buffer += value;
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          if (!event) continue; // comments: ": open", ": keepalive"
          const data = /^data: (.*)$/m.exec(block)?.[1];
          arrivals.push({ event, atMs: at(), ...(data ? { data: JSON.parse(data) } : {}) });
          if (event === 'done') ending = 'done';
        }
      }
    }
  } catch (error) {
    ending = `network error: ${(error as Error).message}`;
  }

  const totalMs = at();
  const ticks = arrivals.filter((a) => a.event === 'tick');
  const gaps = ticks.slice(1).map((tick, i) => tick.atMs - ticks[i]!.atMs);
  const firstTickMs = ticks[0]?.atMs;
  const lastTickMs = ticks.at(-1)?.atMs ?? 0;
  // "Burst": most ticks landed within one second of the last one.
  const burstShare = ticks.length ? ticks.filter((t) => lastTickMs - t.atMs <= 1000).length / ticks.length : 0;

  const verdict =
    ending !== 'done'
      ? 'cut off'
      : ticks.length > 3 && burstShare > 0.8
        ? 'buffered'
        : firstTickMs !== undefined && firstTickMs <= 3000 && median(gaps) <= 1500
          ? 'streams'
          : 'unclear';

  const summary = {
    label: label || '-',
    url: `${target.origin}${target.pathname}`,
    seconds,
    status,
    firstByteMs: firstByteMs ?? null,
    firstTickMs: firstTickMs ?? null,
    ticks: ticks.length,
    medianGapMs: Number.isNaN(median(gaps)) ? null : median(gaps),
    maxGapMs: gaps.length ? Math.max(...gaps) : null,
    burstShare: Number(burstShare.toFixed(2)),
    ending,
    totalMs,
    verdict,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, 'results.md');
  if (!existsSync(file)) {
    writeFileSync(
      file,
      '# Spec 004 results\n\n| Run | When | URL | Seconds | Status | First byte | First tick | Ticks | Median gap | Max gap | Burst share | Ending | Total | Verdict |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n',
    );
  }
  const ms = (v: number | null) => (v === null ? '—' : `${v} ms`);
  appendFileSync(
    file,
    `| ${summary.label} | ${new Date().toISOString()} | ${summary.url} | ${seconds} | ${status} | ${ms(summary.firstByteMs)} | ${ms(summary.firstTickMs)} | ${summary.ticks} | ${ms(summary.medianGapMs)} | ${ms(summary.maxGapMs)} | ${summary.burstShare} | ${ending.replace(/\|/g, '\\|')} | ${ms(totalMs)} | **${verdict}** |\n`,
  );
  if (verdict !== 'streams') process.exitCode = 1;
}

await main();
