// `npm run eval:knowledge` and `npm run eval:agent` only: LLM-judged evals stay out of `npm test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['evals/**/*.eval.ts'], testTimeout: 600_000, hookTimeout: 120_000 },
});
