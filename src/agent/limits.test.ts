import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ default: { warn: log.warn, info: vi.fn(), error: vi.fn() } }));

import { consumeBudgets, LimitStoreError, setAgentLimiters, waitPhrase } from './limits';
import { memoryLimiters } from './test-utils';

beforeEach(() => {
  log.warn.mockClear();
  setAgentLimiters(memoryLimiters());
});

describe('consumeBudgets', () => {
  it('takes a point from each budget while there is room', async () => {
    const limiters = memoryLimiters({ turnsBurst: 2, turnsDaily: 2 });
    setAgentLimiters(limiters);
    expect(await consumeBudgets('u1', ['turnsBurst', 'turnsDaily'])).toEqual({ ok: true });
    expect((await limiters.turnsDaily.consume('u1')).remainingPoints).toBe(0);
  });

  it('refuses when any budget is spent, reporting the longest wait', async () => {
    setAgentLimiters(memoryLimiters({ turnsBurst: 1, turnsDaily: 1 }));
    await consumeBudgets('u1', ['turnsBurst', 'turnsDaily']);
    const refused = await consumeBudgets('u1', ['turnsBurst', 'turnsDaily']);
    expect(refused).toMatchObject({ ok: false, budget: 'turnsDaily' });
    expect(refused.ok === false && refused.msBeforeNext).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it('logs the user id, budget and wait only', async () => {
    setAgentLimiters(memoryLimiters({ support: 1 }));
    await consumeBudgets('u1', ['support']);
    await consumeBudgets('u1', ['support']);
    expect(log.warn).toHaveBeenCalledWith('AGENT_RATE_LIMITED', { userId: 'u1', budget: 'support', msBeforeNext: expect.any(Number) });
  });

  it('throws LimitStoreError when the store fails', async () => {
    setAgentLimiters({ ...memoryLimiters(), writes: { consume: async () => Promise.reject(new Error('mongo down')) } });
    await expect(consumeBudgets('u1', ['writes'])).rejects.toThrow(LimitStoreError);
  });
});

describe('waitPhrase', () => {
  it('rounds up to minutes, then hours', () => {
    expect(waitPhrase(500)).toBe('about 1 minute');
    expect(waitPhrase(61_000)).toBe('about 2 minutes');
    expect(waitPhrase(59 * 60_000)).toBe('about 59 minutes');
    expect(waitPhrase(60 * 60_000)).toBe('about 1 hour');
    expect(waitPhrase(23.2 * 60 * 60_000)).toBe('about 24 hours');
  });
});
