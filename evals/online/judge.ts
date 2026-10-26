// `npm run eval:online` (spec 021): judges one batch of sampled live turns with Claude Haiku 5.5,
// flags the low scorers for review and prints a summary with no customer text (also to the CI
// job summary). Needs ANTHROPIC_API_KEY and ONLINE_EVALS_DATABASE_URL (or DATABASE_URL); skips
// without them. ONLINE_EVAL_DAILY_CAP limits the turns judged per day (default 200).

import { appendFileSync } from 'node:fs';
import mongoose from 'mongoose';
import { AnthropicModel } from 'deepeval/models';
import { AnswerRelevancyMetric, FaithfulnessMetric, GEval } from 'deepeval/metrics';
import { LLMTestCase, SingleTurnParams } from 'deepeval/test-case';
import config from '../../src/config/config.js';
import { judgeBatch, renderSummary, type Judge } from './online';

// Haiku for cheap online sampling (evals.md §10).
const JUDGE_MODEL = 'claude-haiku-5-5';
const DEFAULT_DAILY_CAP = 200;

const print = (text: string) => process.stdout.write(`${text}\n`);

const haikuJudge: Judge = async (snapshot) => {
  const model = () => new AnthropicModel({ model: JUDGE_MODEL, temperature: null });
  const context = snapshot.calls.map((c) => `${c.name}(${c.args}) returned: ${c.result}`);
  const replyCase = new LLMTestCase({ input: snapshot.message, actualOutput: snapshot.reply, ...(context.length ? { retrievalContext: context } : {}) });
  const actions = snapshot.calls.length ? snapshot.calls.map((c) => `${c.name}(${c.args})`).join('; ') : 'none';
  const toolCase = new LLMTestCase({ input: snapshot.message, actualOutput: `Tools called: ${actions}\nReply: ${snapshot.reply}` });
  const toolFit = new GEval({
    name: 'tool fit',
    criteria:
      "An online store's shopping assistant answered the customer. Judge whether the tools it called (or calling none) fit the request: the right tool for what was asked, sensible arguments, nothing the customer didn't ask for.",
    evaluationParams: [SingleTurnParams.INPUT, SingleTurnParams.ACTUAL_OUTPUT],
    model: model(),
  });
  return {
    relevancy: await new AnswerRelevancyMetric({ model: model(), includeReason: false }).measure(replyCase),
    toolFit: await toolFit.measure(toolCase),
    // Faithfulness needs something to be faithful to: tool results.
    ...(context.length ? { faithfulness: await new FaithfulnessMetric({ model: model(), includeReason: false }).measure(replyCase) } : {}),
  };
};

async function main(): Promise<number> {
  const url = process.env.ONLINE_EVALS_DATABASE_URL || config.DATABASE_URL;
  if (!config.ANTHROPIC_API_KEY || !url) {
    const note = 'Online evals skipped: set ANTHROPIC_API_KEY and ONLINE_EVALS_DATABASE_URL (or DATABASE_URL) to run them.';
    print(note);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${note}\n`);
    return 0;
  }
  await mongoose.connect(url);
  const summary = renderSummary(await judgeBatch({ judge: haikuJudge, cap: Number(process.env.ONLINE_EVAL_DAILY_CAP) || DEFAULT_DAILY_CAP }));
  print(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return 0;
}

// Exit explicitly: the app logger's MongoDB transport keeps its own connection open.
main()
  .catch((error: unknown) => {
    process.stderr.write(`Online evals failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  })
  .then(async (code) => {
    await mongoose.disconnect();
    process.exit(code);
  });
