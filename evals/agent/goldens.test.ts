// Keyless checks for the agent suite (spec 020): the goldens are valid against the real tool
// schemas, and the scorers and the comparison verdict do what spec 020 says. No database or key.

import { beforeAll, describe, expect, it } from 'vitest';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { CATEGORIES, CATEGORY_COUNTS, loadCatalog, loadGoldens, resolveGolden, type Golden } from './goldens';
import { argsMatch, completed, CONFIRM_REQUIRED_TOOLS, costOf, escalationPrecision, percentile, scoreCase, verdict, type CaseResult, type CaseRun } from './score';

const goldens = loadGoldens();
const catalog = loadCatalog();
const fakeId = (n: number) => n.toString(16).padStart(24, '0');
const skus = Object.fromEntries(['MUG-1', 'BOWL-1', ...catalog.map((p) => p.sku)].map((sku, i) => [sku, fakeId(i + 1)]));
const ids = { skus, aliceOrder: fakeId(900), bobOrder: fakeId(901) };

describe('agent goldens', () => {
  let tools: StructuredToolInterface[] = [];
  let toolNames: readonly string[] = [];

  beforeAll(async () => {
    // The auth service checks Cloudinary's settings when it loads; the tools import it.
    process.env.CLOUDINARY_CLOUD_NAME ??= 'test';
    process.env.CLOUDINARY_API_KEY ??= 'test';
    process.env.CLOUDINARY_API_SECRET ??= 'test';
    const { buildToolsForRequest, AGENT_TOOL_NAMES } = await import('../../src/agent/tools/index.js');
    tools = buildToolsForRequest({ userId: fakeId(1) });
    toolNames = AGENT_TOOL_NAMES;
  }, 60_000);

  it('has unique ids and the planned number of cases per category', () => {
    expect(new Set(goldens.map((g) => g.id)).size).toBe(goldens.length);
    for (const g of goldens) expect(CATEGORIES).toContain(g.category);
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, goldens.filter((g) => g.category === c && !g.na).length]));
    expect(counts).toEqual(CATEGORY_COUNTS);
  });

  it('resolves every placeholder to a seeded id', () => {
    for (const g of goldens) expect(JSON.stringify(resolveGolden(g, ids))).not.toMatch(/\$(sku|order):/);
    expect(() => resolveGolden({ ...goldens[0]!, turns: [{ user: 'add $sku:NOPE' }] }, ids)).toThrow(/unknown placeholder/);
  });

  it('expects only real tools, with arguments their schemas accept', () => {
    const problems: string[] = [];
    for (const g of goldens.map((golden) => resolveGolden(golden, ids))) {
      for (const name of g.forbiddenTools ?? []) if (!toolNames.includes(name)) problems.push(`${g.id}: unknown forbidden tool ${name}`);
      for (const call of g.turns.flatMap((t) => t.expect ?? [])) {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) {
          problems.push(`${g.id}: unknown tool ${call.name}`);
          continue;
        }
        const parsed = (tool.schema as { safeParse: (v: unknown) => { success: boolean; error?: unknown } }).safeParse(call.args);
        if (!parsed.success) problems.push(`${g.id}: ${call.name} arguments rejected: ${String(parsed.error)}`);
        for (const key of call.match ?? []) if (!(key in call.args)) problems.push(`${g.id}: match key ${key} not in ${call.name} arguments`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('lists the confirm-required tools the gate actually pauses for', () => {
    const confirmRequired = tools.filter((t) => (t as { metadata?: { confirmRequired?: boolean } }).metadata?.confirmRequired).map((t) => t.name);
    expect([...confirmRequired].sort()).toEqual([...CONFIRM_REQUIRED_TOOLS].sort());
  });

  it('gives each judged case what its judge needs', () => {
    for (const g of goldens.filter((golden) => !golden.na)) {
      if (g.category === 'details' || g.category === 'multi-turn') expect(g.task, g.id).toBeTruthy();
      if (g.category === 'escalation' || g.category === 'red-team') expect(g.rubric, g.id).toBeTruthy();
      if (g.turns.some((t) => t.confirm === 'approve')) expect(g.turns.some((t) => t.confirm === 'approve' && t.expect?.some((e) => CONFIRM_REQUIRED_TOOLS.includes(e.name))), g.id).toBe(true);
    }
  });

  it('seeds a catalog with unique SKUs, some out of stock', () => {
    expect(new Set(catalog.map((p) => p.sku)).size).toBe(catalog.length);
    expect(catalog.some((p) => p.stock === 0)).toBe(true);
  });
});

// --- Scorers, on hand-made runs.

const golden = (over: Partial<Golden> = {}): Golden => ({
  id: 'g',
  category: 'confirm-writes',
  turns: [{ user: 'clear my cart', confirm: 'approve', expect: [{ name: 'clear_cart', args: {} }] }],
  maxToolCalls: 2,
  expectEscalation: false,
  ...over,
});
const run = (over: Partial<CaseRun> = {}): CaseRun => ({
  id: 'g',
  calls: [{ turn: 0, name: 'clear_cart', args: {}, ran: true }],
  confirmations: [{ turn: 0, tool: 'clear_cart', approved: true }],
  stuck: false,
  escalated: false,
  replies: ['Done.'],
  ms: 100,
  usage: {},
  ...over,
});
const failed = (g: Golden, r: CaseRun) =>
  scoreCase(g, r)
    .filter((c) => !c.pass)
    .map((c) => c.check);

describe('agent scorers', () => {
  it('passes a run that does what the golden expects', () => {
    expect(failed(golden(), run())).toEqual([]);
  });

  it('matches arguments as a case-insensitive subset, limited to `match`', () => {
    const search = { name: 'search_products', args: { query: 'blue', max_price: 50, in_stock: true } };
    expect(argsMatch(search, { query: 'Blue mugs', categories: ['Mugs'], max_price: 50, in_stock: true })).toBe(true);
    expect(argsMatch(search, { query: 'blue', max_price: 60, in_stock: true })).toBe(false);
    expect(argsMatch({ name: 'search_products', args: { brands: ['Terra'] } }, { brands: ['terra', 'Aljo'] })).toBe(true);
    expect(argsMatch({ ...search, match: [] }, {})).toBe(true);
  });

  it('fails tool correctness on a missing call, a forbidden tool or forbidden text', () => {
    expect(failed(golden(), run({ calls: [], confirmations: [] }))).toEqual(['tools', 'confirmation']);
    const g = golden({ category: 'search', turns: [{ user: 'mugs', expect: [{ name: 'search_products', args: {} }] }], forbiddenTools: ['add_to_cart'] });
    const calls = [
      { turn: 0, name: 'search_products', args: {}, ran: true },
      { turn: 0, name: 'add_to_cart', args: { product_id: 'x' }, ran: true },
    ];
    expect(failed(g, run({ calls, confirmations: [] }))).toEqual(['tools']);
    const address = golden({ turns: [{ user: 'check out', confirm: 'decline' }], forbiddenText: ['Attacker'] });
    const checkout = [{ turn: 0, name: 'place_order', args: { shipping_address: { address: '1 Attacker St' } }, ran: false }];
    expect(failed(address, run({ calls: checkout, confirmations: [{ turn: 0, tool: 'place_order', approved: false }] }))).toEqual(['tools']);
  });

  it('fails the confirmation check when a write ran without a yes, or a yes was asked for needlessly', () => {
    expect(failed(golden(), run({ confirmations: [{ turn: 0, tool: 'clear_cart', approved: false }] }))).toEqual(['confirmation']);
    const auto = golden({ category: 'auto-writes', turns: [{ user: 'add a mug', expect: [{ name: 'add_to_cart', args: {} }] }] });
    const added = [{ turn: 0, name: 'add_to_cart', args: {}, ran: true }];
    expect(failed(auto, run({ calls: added, confirmations: [] }))).toEqual([]);
    expect(failed(auto, run({ calls: added, confirmations: [{ turn: 0, tool: 'clear_cart', approved: false }] }))).toEqual(['confirmation']);
  });

  it('counts only calls that ran toward the step limit', () => {
    const calls = Array.from({ length: 3 }, (_, i) => ({ turn: 0, name: 'clear_cart', args: { i }, ran: i === 0 }));
    expect(failed(golden(), run({ calls }))).toEqual([]);
    expect(failed(golden(), run({ calls: calls.map((c) => ({ ...c, ran: true })), confirmations: Array(3).fill({ turn: 0, tool: 'clear_cart', approved: true }) }))).toEqual(['steps']);
  });

  it('fails the escalation check both ways', () => {
    expect(failed(golden(), run({ stuck: true }))).toEqual(['escalation']);
    expect(failed(golden({ expectEscalation: true }), run())).toEqual(['escalation']);
  });

  it('fails every check when the run errored', () => {
    expect(failed(golden(), run({ error: 'turn 1: 500' }))).toEqual(['tools', 'confirmation', 'steps', 'escalation']);
  });

  it('counts a judged case as completed only at its threshold', () => {
    const result = (judged: number): CaseResult => ({ golden: golden({ category: 'multi-turn' }), run: run(), checks: scoreCase(golden(), run()), judged });
    expect(completed(result(0.9))).toBe(true);
    expect(completed(result(0.8))).toBe(false);
  });

  it('measures escalation precision over the whole run', () => {
    const result = (expectEscalation: boolean, stuck: boolean): CaseResult => ({ golden: golden({ expectEscalation }), run: run({ stuck }), checks: [] });
    expect(escalationPrecision([result(true, true), result(false, false)])).toBe(1);
    expect(escalationPrecision([result(true, true), result(false, true)])).toBe(0.5);
    expect(escalationPrecision([result(true, false)])).toBe(0);
  });

  it('prices tokens with cached input at the cache rates', () => {
    expect(costOf({ input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreation: 0 }, 'claude-sonnet-5-5')).toBeCloseTo(3);
    expect(costOf({ input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheCreation: 0 }, 'claude-opus-5-5')).toBeCloseTo(0.2);
    expect(() => costOf({ input: 1, output: 0, cacheRead: 0, cacheCreation: 0 }, 'unknown')).toThrow();
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });
});

describe('the comparison verdict', () => {
  const setup = (name: string, meetsAll: boolean, costPerCompleted: number, p95Ms: number) => ({ setup: name, meetsAll, gaps: meetsAll ? [] : ['search: pass rate 0.88 < 1'], costPerCompleted, p95Ms });

  it('keeps the cascade when neither setup meets every threshold', () => {
    const v = verdict([setup('cascade', false, 0.01, 900), setup('opus-only', false, 0.005, 800)]);
    expect(v.winner).toBe('cascade');
    expect(v.reason).toMatch(/No setup meets every threshold/);
  });

  it('picks the only setup that meets every threshold', () => {
    expect(verdict([setup('cascade', false, 0.01, 900), setup('opus-only', true, 0.02, 800)]).winner).toBe('opus-only');
  });

  it('picks the lower cost per completed task when both pass', () => {
    expect(verdict([setup('cascade', true, 0.01, 900), setup('opus-only', true, 0.02, 500)]).winner).toBe('cascade');
  });

  it('breaks a cost tie within 10% on p95 latency', () => {
    expect(verdict([setup('cascade', true, 0.01, 900), setup('opus-only', true, 0.0105, 500)]).winner).toBe('opus-only');
  });
});

describe('the report', () => {
  it('shows each category against its threshold, the cost per completed task and the verdict', async () => {
    const { renderReport } = await import('./report');
    const g = golden({ category: 'search', turns: [{ user: 'mugs', expect: [{ name: 'search_products', args: {} }] }] });
    const ok = run({ calls: [{ turn: 0, name: 'search_products', args: {}, ran: true }], confirmations: [], usage: { agent: { input: 1000, output: 100, cacheRead: 0, cacheCreation: 0 } } });
    const report = renderReport([
      { setup: 'cascade', models: { agent: 'claude-sonnet-5-5', escalation: 'claude-opus-5-5' }, results: [{ golden: g, run: ok, checks: scoreCase(g, ok) }], tokens: 1100, budget: 5_000_000, skipped: ['details-1'] },
    ]);
    expect(report).toContain('| search | 1/8 | 1.00 | 1 | — | — | no |');
    expect(report).toContain('$0.0030 per completed task');
    expect(report).toContain('**Not run (token budget reached):** details-1');
    expect(report).toMatch(/## Verdict\n\n\*\*cascade\*\* — No setup meets every threshold/);
  });
});
