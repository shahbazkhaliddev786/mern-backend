// C13 (spec 001): does deepeval 0.9.22 run next to @langchain/core 1.2.17?
// deepeval lists @langchain/core as an optional peer pinned to 1.1.31; only its
// LangChain integration loads it. Both halves are checked. Without availableTools,
// ToolCorrectnessMetric scores deterministically, so no judge model is called.

import { describe, expect, it } from 'vitest';
import 'deepeval/vitest';
import { ToolCorrectnessMetric } from 'deepeval/metrics';
import { LLMTestCase, ToolCall } from 'deepeval/test-case';

const testCase = () =>
  new LLMTestCase({
    input: 'show me running shoes under $50',
    actualOutput: '',
    toolsCalled: [new ToolCall({ name: 'search_products', inputParameters: { query: 'running shoes', price_max: 50 } })],
    expectedTools: [new ToolCall({ name: 'search_products', inputParameters: { query: 'running shoes', price_max: 50 } })],
  });

describe('C13 deepeval', () => {
  it('runs a deterministic metric with no judge model', async () => {
    const metric = new ToolCorrectnessMetric({ threshold: 1, includeReason: false });
    const score = await metric.measure(testCase());
    expect(score).toBe(1);
  });

  it('supports the toPass matcher', async () => {
    await expect(testCase()).toPass([new ToolCorrectnessMetric({ threshold: 1, includeReason: false })]);
  });

  it('loads its LangChain integration with the installed @langchain/core', async () => {
    const { DeepEvalCallbackHandler } = await import('deepeval/integrations/langchain');
    expect(() => new DeepEvalCallbackHandler({ name: 'spike' })).not.toThrow();
  });
});
