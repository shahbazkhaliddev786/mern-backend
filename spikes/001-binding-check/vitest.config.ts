// Runs only the C13 spike test, so the backend's `npm test` never picks it up.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['spikes/001-binding-check/c13-deepeval.spike.ts'] },
});
