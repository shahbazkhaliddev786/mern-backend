// The agent's real per-user limiters, and the site's per-IP limiter, against Postgres (spec 014,
// spec 023): counters in the migrations' `rate_limits` table.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiterPostgres } from 'rate-limiter-flexible';
import config from '../config/config.js';
import { getPool } from '../db/client.js';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db.js';
import { consumeBudgets, getAgentLimiters, setAgentLimiters } from './limits.js';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

describe.skipIf(!TEST_DATABASE_URL)('rate limiters on Postgres', () => {
  const env = config.ENV;
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase('limits');
    // The site's per-IP limiter is off in development; the agent's must not be.
    config.ENV = 'development';
    setAgentLimiters(null);
  }, 60_000);
  afterAll(async () => {
    config.ENV = env;
    setAgentLimiters(null);
    await testDb?.drop();
  });

  it('are created on first use, once, and on in development', () => {
    const limiters = getAgentLimiters();
    expect(limiters.support).toBeInstanceOf(RateLimiterPostgres);
    expect(getAgentLimiters()).toBe(limiters);
  });

  it('refuse the 4th support message in an hour, per user', async () => {
    for (let i = 0; i < 3; i++) expect(await consumeBudgets('user-a', ['support'])).toEqual({ ok: true });
    expect(await consumeBudgets('user-a', ['support'])).toMatchObject({ ok: false, budget: 'support' });
    expect(await consumeBudgets('user-b', ['support'])).toEqual({ ok: true });
  });

  it('keep every counter in the one table, under each limiter\'s own prefix', async () => {
    const { rows } = await getPool().query('SELECT key, points FROM rate_limits ORDER BY key');
    expect(rows).toEqual([
      { key: 'agent_support:user-a', points: 4 },
      { key: 'agent_support:user-b', points: 1 },
    ]);
  });

  it("the site's per-IP limiter is on outside development, in the same table", async () => {
    const { getRateLimiter } = await import('../config/rate.limiter.js');
    expect(getRateLimiter()).toBeNull();
    config.ENV = 'production';
    try {
      const limiter = getRateLimiter();
      expect(limiter).toBeInstanceOf(RateLimiterPostgres);
      expect((await limiter!.consume('203.0.113.7')).remainingPoints).toBe(99);
      const { rows } = await getPool().query("SELECT points FROM rate_limits WHERE key = 'rl:203.0.113.7'");
      expect(rows).toEqual([{ points: 1 }]);
    } finally {
      config.ENV = 'development';
    }
  });
});
