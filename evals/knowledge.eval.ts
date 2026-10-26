// Store-knowledge evals (spec 013, evals.md): the real agent model and tool, judged by Opus.
// Needs ANTHROPIC_API_KEY, VOYAGE_API_KEY and DATABASE_URL pointing at an Atlas database where
// `npm run agent:setup` and `npm run agent:ingest` have run. Skipped without them.
//   npm run eval:knowledge

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import mongoose from 'mongoose';
import { AnthropicModel } from 'deepeval/models';
import { ContextualPrecisionMetric, ContextualRecallMetric, ContextualRelevancyMetric, FaithfulnessMetric } from 'deepeval/metrics';
import { LLMTestCase } from 'deepeval/test-case';
import config from '../src/config/config.js';
import { getAgentConfig } from '../src/agent/config.js';
import { buildAgentGraph, createChatModel, RECURSION_LIMIT } from '../src/agent/graph.js';
import { visibleText } from '../src/agent/stream.js';
import { askStoreKnowledgeTool } from '../src/agent/tools/ask-store-knowledge.js';
import { judgeFromEnv } from './agent/setups';

interface Golden {
  id: string;
  kind: 'answer' | 'fallback' | 'follow-up';
  history?: string[];
  input: string;
  expectedOutput: string;
  expectedChunkIds: string[];
}

// evals.md thresholds, on the mean over the answerable goldens.
const THRESHOLDS = { recall: 0.8, precision: 0.7, faithfulness: 0.9 };
const READY = Boolean(config.ANTHROPIC_API_KEY && config.VOYAGE_API_KEY && config.DATABASE_URL);

interface Turn {
  answer: string;
  /** The passages the tool returned in the last turn, as the judge sees them. */
  retrievalContext: string[];
  found: boolean | null;
}

async function askAgent(golden: Golden): Promise<Turn> {
  const agentConfig = getAgentConfig({ ...config, AGENT_ENABLED: 'true' });
  const graph = buildAgentGraph({
    model: createChatModel(agentConfig),
    tools: [askStoreKnowledgeTool({ userId: 'eval-user' })],
    checkpointer: new MemorySaver(),
    userId: 'eval-user',
  });
  const run = { configurable: { thread_id: golden.id }, recursionLimit: RECURSION_LIMIT };
  let messages: BaseMessage[] = [];
  let start = 0;
  for (const text of [...(golden.history ?? []), golden.input]) {
    start = messages.length;
    const state = await graph.invoke({ messages: [new HumanMessage(text)], toolCalls: 0 }, run);
    messages = state.messages as BaseMessage[];
  }
  const turn = messages.slice(start);
  const results = turn
    .filter((m) => m instanceof ToolMessage)
    .map((m) => JSON.parse(String(m.content)) as { found?: boolean; passages?: { topic: string; question: string; text: string }[] });
  return {
    answer: visibleText((turn.filter((m) => m instanceof AIMessage).at(-1) as AIMessage | undefined)?.content ?? ''),
    retrievalContext: results.flatMap((r) => r.passages ?? []).map((p) => `${p.topic} — ${p.question}\n${p.text}`),
    found: results.length ? results.some((r) => r.found === true) : null,
  };
}

describe.skipIf(!READY)('store knowledge evals', () => {
  let goldens: Golden[] = [];
  // EVAL_JUDGE: Sonnet by default, for cost; Opus for scores that count (spec 020 decision log).
  const judge = () => new AnthropicModel({ model: judgeFromEnv().model, temperature: null });

  beforeAll(async () => {
    goldens = (JSON.parse(await readFile('evals/knowledge.goldens.json', 'utf8')) as { goldens: Golden[] }).goldens;
    await mongoose.connect(config.DATABASE_URL);
  });
  afterAll(() => mongoose.disconnect());

  it('retrieves the right passages and answers only from them', async () => {
    const scores = { recall: [] as number[], precision: [] as number[], relevancy: [] as number[], faithfulness: [] as number[] };
    for (const golden of goldens.filter((g) => g.kind !== 'fallback')) {
      const turn = await askAgent(golden);
      const testCase = new LLMTestCase({
        input: golden.input,
        actualOutput: turn.answer,
        expectedOutput: golden.expectedOutput,
        retrievalContext: turn.retrievalContext.length ? turn.retrievalContext : ['(nothing retrieved)'],
      });
      const measured = {
        recall: await new ContextualRecallMetric({ model: judge(), includeReason: false }).measure(testCase),
        precision: await new ContextualPrecisionMetric({ model: judge(), includeReason: false }).measure(testCase),
        relevancy: await new ContextualRelevancyMetric({ model: judge(), includeReason: false }).measure(testCase),
        faithfulness: await new FaithfulnessMetric({ model: judge(), includeReason: false }).measure(testCase),
      };
      for (const key of Object.keys(scores) as (keyof typeof scores)[]) scores[key].push(measured[key]);
      process.stdout.write(`${golden.id}: ${JSON.stringify(measured)}\n`);
    }
    const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / (values.length || 1);
    const summary = Object.fromEntries(Object.entries(scores).map(([key, values]) => [key, Number(mean(values).toFixed(3))]));
    process.stdout.write(`knowledge eval means: ${JSON.stringify(summary)}\n`);
    expect(summary.recall).toBeGreaterThanOrEqual(THRESHOLDS.recall);
    expect(summary.precision).toBeGreaterThanOrEqual(THRESHOLDS.precision);
    expect(summary.faithfulness).toBeGreaterThanOrEqual(THRESHOLDS.faithfulness);
  });

  it('falls back to the contact options for unpublished topics', async () => {
    const misses: string[] = [];
    for (const golden of goldens.filter((g) => g.kind === 'fallback')) {
      const turn = await askAgent(golden);
      const pointsToContact = /hello@aljostore\.com|\/contact/i.test(turn.answer);
      if (turn.found !== false || !pointsToContact) misses.push(`${golden.id} (found: ${String(turn.found)})`);
    }
    expect(misses).toEqual([]);
  });
});
