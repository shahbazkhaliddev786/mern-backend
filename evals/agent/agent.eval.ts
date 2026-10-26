// The judged agent suite (spec 020, evals.md §6 and §8): every golden through the real router,
// tools and MongoDB with real models, for each setup; deterministic checks plus an Opus judge
// (Sonnet cross-checks turns Opus wrote); then the report and the cascade-vs-Opus verdict.
// Needs ANTHROPIC_API_KEY and MONGO_URL; skipped without them.
//   MONGO_URL=… npm run eval:agent
// Options (cheap by default, for a small API budget): EVAL_SETUP=cascade|opus-only|both,
// EVAL_CASES=smoke|all|<ids>, EVAL_JUDGE=sonnet|opus, EVAL_TOKEN_BUDGET (per setup).

import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnthropicModel } from 'deepeval/models';
import { GEval, TaskCompletionMetric } from 'deepeval/metrics';
import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';
import config from '../../src/config/config.js';
import { getAgentConfig } from '../../src/agent/config.js';
import type { Harness } from '../safety/harness';
import { loadCatalog, loadGoldens, resolveGolden, selectCases, type Golden } from './goldens';
import { completed, scoreCase, type CaseResult, type CaseRun } from './score';
import { renderReport, summarize, type SetupRun } from './report';
import { buildSetup, judgeFromEnv, setupsFromEnv } from './setups';

vi.mock('../../src/config/stripe.js', async () => (await import('./mocks')).stripe());
vi.mock('../../src/utils/order.confirmation.email.js', async () => (await import('./mocks')).email());
vi.mock('../../src/services/support.service.js', async () => (await import('./mocks')).support());
vi.mock('../../src/agent/alerts.js', async () => (await import('./mocks')).alerts());
vi.mock('../../src/services/order.service.js', async (importOriginal) => (await import('./mocks')).orderService(await importOriginal()));
vi.mock('../../src/services/product.service.js', async (importOriginal) => (await import('./mocks')).productService(await importOriginal()));

const MONGO_URL = process.env.MONGO_URL;
const READY = Boolean(config.ANTHROPIC_API_KEY && MONGO_URL);
// Per setup, agent plus judge. Cached tokens count in full, so the cap overstates the cost.
const BUDGET = Number(process.env.EVAL_TOKEN_BUDGET ?? 300_000);
const CASES = process.env.EVAL_CASES ?? 'smoke';
const JUDGE = judgeFromEnv();

/** Pricing set to 1 per token, so a metric's evaluationCost is its token count. */
const judge = (model: string) => new AnthropicModel({ model, temperature: null, costPerInputToken: 1, costPerOutputToken: 1 });

const tokensOf = (run: CaseRun) => Object.values(run.usage).reduce((sum, u) => sum + u.input + u.output, 0);

/** The conversation as the judge reads it: each customer message, the actions taken and the reply. */
function transcript(golden: Golden, run: CaseRun): string {
  return golden.turns
    .map((turn, i) => {
      const actions = run.calls
        .filter((c) => c.turn === i)
        .map((c) => `${c.name}(${JSON.stringify(c.args)})${c.ran ? '' : ' [not run]'}`);
      const confirmations = run.confirmations.filter((c) => c.turn === i).map((c) => `asked to confirm ${c.tool}: customer ${c.approved ? 'approved' : 'declined'}`);
      return [`Customer: ${turn.user}`, ...(actions.length ? [`Actions: ${actions.join('; ')}`] : []), ...confirmations, `Assistant: ${run.replies[i] ?? '(no reply)'}`].join('\n');
    })
    .join('\n\n');
}

/** One judgement with one judge model, and the tokens it cost. */
async function score(golden: Golden, run: CaseRun, model: string): Promise<{ score: number; tokens: number }> {
  const testCase = new LLMTestCase({ input: golden.turns.map((t) => t.user).join('\n'), actualOutput: transcript(golden, run) });
  const metric = golden.task
    ? new TaskCompletionMetric({ task: golden.task, model: judge(model), includeReason: false })
    : new GEval({
        name: `${golden.category} behaviour`,
        criteria: `${golden.rubric} Judge the assistant's replies and actions in the conversation.`,
        evaluationParams: [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
        model: judge(model),
      });
  const value = await metric.measure(testCase);
  return { score: value, tokens: metric.evaluationCost ?? 0 };
}

describe.skipIf(!READY)('agent suite: judged, both setups', () => {
  let h: Harness;
  let goldens: Golden[] = [];
  const runs: SetupRun[] = [];

  beforeAll(async () => {
    const { startHarness } = await import('../safety/harness');
    h = await startHarness(MONGO_URL as string, { dbName: 'agent_eval_judged', catalog: loadCatalog() });
    goldens = selectCases(loadGoldens(), CASES).map((g) => resolveGolden(g, h.ids));
  }, 120_000);

  afterAll(async () => {
    if (runs.length) {
      const report = renderReport(runs, { judge: JUDGE, cases: CASES });
      writeFileSync('evals/agent/last-run.md', report);
      process.stdout.write(`${report}\n`);
    }
    await h?.stop();
  });

  it('meets every threshold with the production setup, and compares the setups', async () => {
    const { runCase } = await import('./run');
    const agentConfig = getAgentConfig({ ...config, AGENT_ENABLED: 'true' });
    for (const name of setupsFromEnv()) {
      const setup = buildSetup(name, agentConfig);
      h.setModel(setup.agent);
      h.setEscalation(setup.escalation);
      const run: SetupRun = { setup: name, models: setup.models, results: [], tokens: 0, budget: BUDGET, skipped: [] };
      runs.push(run);
      for (const golden of goldens) {
        if (run.tokens >= BUDGET) {
          run.skipped.push(golden.id);
          continue;
        }
        const caseRun = await runCase(h, golden, h.ids.alice);
        run.tokens += tokensOf(caseRun);
        const result: CaseResult = { golden, run: caseRun, checks: scoreCase(golden, caseRun) };
        if ((golden.task || golden.rubric) && !caseRun.error) {
          const primary = await score(golden, caseRun, JUDGE.model);
          result.judged = primary.score;
          run.tokens += primary.tokens;
          // Opus judging Opus: cross-check with Sonnet (evals.md §10).
          if (JUDGE.crossModel && (name === 'opus-only' || caseRun.escalated)) {
            const cross = await score(golden, caseRun, JUDGE.crossModel);
            result.crossJudged = cross.score;
            run.tokens += cross.tokens;
          }
        }
        run.results.push(result);
        process.stdout.write(`${name} ${golden.id}: ${completed(result) ? 'completed' : 'NOT completed'} (${caseRun.ms} ms)\n`);
      }
    }
    // The comparison's other setup is reported, not gated: it isn't what customers get. A category
    // the budget cut short is reported as partial, not asserted.
    const production = runs.find((r) => r.setup === 'cascade');
    if (production)
      expect(
        summarize(production)
          .categories.filter((c) => c.cases === c.planned)
          .flatMap((c) => c.gaps),
      ).toEqual([]);
  });
});
