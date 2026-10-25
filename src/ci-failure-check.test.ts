// TEMPORARY (spec 019): proves a failing test turns CI red. Reverted in the next commit.
import { expect, it } from 'vitest';

it('fails on purpose', () => {
  expect(1).toBe(2);
});
