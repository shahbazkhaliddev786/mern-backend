// Spec 001 runner. Usage (from mern-backend/):
//   npx tsx spikes/001-binding-check/run.ts --offline   # mocked API, no key needed
//   ANTHROPIC_API_KEY=... npx tsx spikes/001-binding-check/run.ts   # live API
// Writes results-offline.md or results-live.md next to this file.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c1, c2, c3, c4, c5, c6c7, c8, c9, c10, c11, c12, newCtx, type CheckResult } from './checks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const offline = process.argv.includes('--offline');

if (!offline && !process.env.ANTHROPIC_API_KEY) {
  process.stderr.write('ANTHROPIC_API_KEY is not set. Use --offline, or set the key for a live run.\n');
  process.exit(1);
}

function installed(pkg: string, from = root): string {
  const file = path.join(from, 'node_modules', pkg, 'package.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

// deepeval 0.9.20-0.9.22 ship a stale dist/telemetry.js next to dist/telemetry/; Node
// resolves require("../telemetry") to the stale file, which needs the undeclared
// @sentry/node and lacks the functions the metrics call. C13 runs twice: as installed,
// then with that file moved aside (restored afterwards) to answer the @langchain/core question.
const STALE_TELEMETRY = path.join(root, 'node_modules/deepeval/dist/telemetry.js');

function vitestC13(): { ok: boolean; summary: string } {
  try {
    const out = execFileSync('npx', ['vitest', 'run', '--config', 'spikes/001-binding-check/vitest.config.ts'], {
      env: { ...process.env, DEEPEVAL_TELEMETRY_OPT_OUT: 'YES' },
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, summary: out.split('\n').filter((l) => /Tests\s+\d/.test(l)).join(' ').trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const lines = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.split('\n').filter((l) => /Error|Tests\s+\d/.test(l));
    return { ok: false, summary: [...new Set(lines.map((l) => l.trim()))].slice(0, 4).join(' / ') };
  }
}

function c13(): CheckResult {
  const asInstalled = vitestC13();
  let patched = { ok: false, summary: 'not run' };
  if (!asInstalled.ok && existsSync(STALE_TELEMETRY)) {
    const aside = `${STALE_TELEMETRY}.spike-aside`;
    renameSync(STALE_TELEMETRY, aside);
    try {
      patched = vitestC13();
    } finally {
      renameSync(aside, STALE_TELEMETRY);
    }
  }
  const note = asInstalled.ok
    ? ''
    : patched.ok
      ? 'fails as installed only because of the stale dist/telemetry.js; with it moved aside everything passes, including the LangChain integration on @langchain/core 1.2.17'
      : 'fails even with the stale telemetry file moved aside';
  return {
    id: 'C13',
    name: 'deepeval with @langchain/core 1.2.17',
    binding: asInstalled.ok ? 'pass' : 'fail',
    sdk: 'n/a',
    evidence: `as installed: ${asInstalled.summary}; stale telemetry.js moved aside: ${patched.summary}`,
    note,
  };
}

async function main() {
  const ctx = newCtx(offline);
  const results: CheckResult[] = [];
  const steps: (() => Promise<CheckResult | CheckResult[]>)[] = [c1, c2, c3, c4, c5, c6c7, c8, c9, c10, c11, c12].map(
    (fn) => () => fn(ctx),
  );
  for (const step of steps) {
    const out = await step();
    results.push(...(Array.isArray(out) ? out : [out]));
    ctx.capture.reset();
  }
  results.push(c13());

  const versions = {
    '@langchain/anthropic': installed('@langchain/anthropic'),
    '@anthropic-ai/sdk (nested in @langchain/anthropic)': installed('@anthropic-ai/sdk', path.join(root, 'node_modules/@langchain/anthropic')),
    '@anthropic-ai/sdk (top level, control)': installed('@anthropic-ai/sdk'),
    '@langchain/core': installed('@langchain/core'),
    deepeval: installed('deepeval'),
  };

  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    `# Spec 001 results — ${offline ? 'offline (mocked API)' : 'live API'}`,
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    '| Package | Version |',
    '|---|---|',
    ...Object.entries(versions).map(([k, v]) => `| \`${k}\` | ${v} |`),
    '',
    '| Check | ChatAnthropic | SDK control | Evidence | Notes |',
    '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} ${r.name} | ${r.binding} | ${r.sdk} | ${cell(r.evidence)} | ${cell(r.note ?? '')} |`),
    '',
  ].join('\n');

  const file = path.join(here, offline ? 'results-offline.md' : 'results-live.md');
  writeFileSync(file, md);
  process.stdout.write(`${md}\nWrote ${path.relative(root, file)}\n`);
  if (results.some((r) => r.binding === 'fail' || r.sdk === 'fail')) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
