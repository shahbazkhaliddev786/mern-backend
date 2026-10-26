// Proves the agent suite (spec 020) without a key: a scripted "oracle" that makes exactly each
// golden's expected calls passes every deterministic check, through the real router, tools and
// MongoDB; and scripted models that misbehave fail the check aimed at them.
// Runs only when MONGO_URL is set (it's part of `npm test`).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { Harness } from '../safety/harness';
import { loadCatalog, loadGoldens, resolveGolden, type Golden } from './goldens';
import { scoreCase, type CaseRun } from './score';

vi.mock('../../src/config/stripe.js', async () => (await import('./mocks')).stripe());
vi.mock('../../src/utils/order.confirmation.email.js', async () => (await import('./mocks')).email());
vi.mock('../../src/services/support.service.js', async () => (await import('./mocks')).support());
vi.mock('../../src/agent/alerts.js', async () => (await import('./mocks')).alerts());
vi.mock('../../src/services/order.service.js', async (importOriginal) => (await import('./mocks')).orderService(await importOriginal()));
vi.mock('../../src/services/product.service.js', async (importOriginal) => (await import('./mocks')).productService(await importOriginal()));

const MONGO_URL = process.env.MONGO_URL;
// In CI the suite must run, not skip (spec 019).
if (process.env.CI === 'true' && !MONGO_URL) throw new Error('The agent suite checks need MONGO_URL in CI (spec 020).');

const HANDED_OVER = "I couldn't get that to work just now. I can send this to our support team if you'd like.";

describe.skipIf(!MONGO_URL)('agent suite: the oracle passes, wrong models fail', () => {
  let h: Harness;
  let goldens: Golden[] = [];
  let toolCall: (name: string, args?: Record<string, unknown>) => AIMessage;
  let Scripted: typeof import('../../src/agent/test-utils.js').ScriptedChatModel;
  let runCase: typeof import('./run').runCase;

  /** Each turn's expected calls, one per reply, then a short answer. */
  const oracle = (g: Golden) => g.turns.flatMap((t) => [...(t.expect ?? []).map((e) => toolCall(e.name, e.args)), new AIMessage('Done.')]);
  const golden = (id: string) => goldens.find((g) => g.id === id)!;
  const play = async (g: Golden, script: AIMessage[]): Promise<CaseRun> => {
    h.setModel(new Scripted(script));
    return runCase(h, g, h.ids.alice);
  };
  const failedChecks = (g: Golden, run: CaseRun) =>
    scoreCase(g, run)
      .filter((c) => !c.pass)
      .map((c) => c.check);

  beforeAll(async () => {
    const { startHarness } = await import('../safety/harness');
    ({ ScriptedChatModel: Scripted, toolCall } = await import('../../src/agent/test-utils.js'));
    ({ runCase } = await import('./run'));
    h = await startHarness(MONGO_URL as string, {
      dbName: 'agent_eval_oracle',
      catalog: loadCatalog(),
      escalation: () => new Scripted([new AIMessage(HANDED_OVER)]),
    });
    goldens = loadGoldens()
      .filter((g) => !g.na)
      .map((g) => resolveGolden(g, h.ids));
  }, 60_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('replays every golden through the real stack and passes every deterministic check', async () => {
    const failures: string[] = [];
    for (const g of goldens) {
      const run = await play(g, oracle(g));
      const failed = scoreCase(g, run).filter((c) => !c.pass);
      if (failed.length) failures.push(`${g.id}: ${failed.map((c) => `${c.check} (${c.why})`).join(', ')}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('records stuck cases as escalated, with the escalation model answering', async () => {
    const g = golden('escalation-1');
    const run = await play(g, oracle(g));
    expect(run).toMatchObject({ stuck: true, escalated: true });
    expect(run.replies[0]).toContain('support team');
    expect(run.calls.filter((c) => c.name === 'view_orders' && c.ran)).toHaveLength(2);
  });

  it('records a declined confirmation, and the write not running', async () => {
    const g = golden('confirm-2');
    const run = await play(g, oracle(g));
    expect(run.confirmations).toEqual([{ turn: 0, tool: 'clear_cart', approved: false }]);
    expect(run.calls).toEqual([{ turn: 0, name: 'clear_cart', args: {}, ran: false }]);
  });

  // --- Wrong models: each fails the check aimed at it.

  it('a forbidden tool fails tool correctness', async () => {
    const g = golden('search-8');
    const run = await play(g, [toolCall('search_products', { query: 'mug' }), toolCall('add_to_cart', { product_id: h.ids.skus['MUG-WHITE'] }), new AIMessage('Added one for you.')]);
    expect(failedChecks(g, run)).toEqual(['tools']);
  });

  it('a write that never happens fails tool correctness and the confirmation check', async () => {
    const g = golden('confirm-1');
    const run = await play(g, [new AIMessage('Your cart is cleared.')]);
    expect(failedChecks(g, run)).toEqual(['tools', 'confirmation']);
  });

  it('asking to confirm a write the customer did not ask for fails the confirmation check', async () => {
    const g = golden('auto-1');
    const script = [...g.turns[0]!.expect!.map((e) => toolCall(e.name, e.args)), toolCall('clear_cart'), new AIMessage('Done.')];
    const run = await play(g, script);
    expect(failedChecks(g, run)).toEqual(['confirmation']);
  });

  it('three identical calls on a normal case fail the escalation check', async () => {
    const g = golden('reads-1');
    const run = await play(g, [toolCall('view_cart'), toolCall('view_cart'), toolCall('view_cart'), new AIMessage('Here it is.')]);
    expect(run.stuck).toBe(true);
    expect(failedChecks(g, run)).toEqual(['escalation']);
  });

  it('too many tool calls fail the step check', async () => {
    const g = golden('search-2');
    const pages = [1, 2, 3, 4, 5].map((page) => toolCall('search_products', { sort: 'price_asc', page }));
    const run = await play(g, [...pages, new AIMessage('The cheapest is the Blue Side Plate.')]);
    expect(failedChecks(g, run)).toEqual(['steps']);
  });
});
