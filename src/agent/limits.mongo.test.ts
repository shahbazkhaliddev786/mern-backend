// The agent's real per-user limiters against MongoDB (spec 014). Runs only when MONGO_URL is set.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import config from '../config/config.js';
import { consumeBudgets, getAgentLimiters, setAgentLimiters } from './limits.js';

const MONGO_URL = process.env.MONGO_URL;

describe.skipIf(!MONGO_URL)('agent limiters on MongoDB', () => {
  const env = config.ENV;

  beforeAll(async () => {
    await mongoose.connect(`${MONGO_URL}/agent_limits_test`);
    await mongoose.connection.dropDatabase();
    // The site's per-IP limiter is off in development; these must not be.
    config.ENV = 'development';
    setAgentLimiters(null);
  });
  afterAll(async () => {
    config.ENV = env;
    setAgentLimiters(null);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  it('are created on first use, once, and on in development', () => {
    const limiters = getAgentLimiters();
    expect(limiters.support).toBeInstanceOf(RateLimiterMongo);
    expect(getAgentLimiters()).toBe(limiters);
  });

  it('refuse the 4th support message in an hour, per user', async () => {
    for (let i = 0; i < 3; i++) expect(await consumeBudgets('user-a', ['support'])).toEqual({ ok: true });
    expect(await consumeBudgets('user-a', ['support'])).toMatchObject({ ok: false, budget: 'support' });
    expect(await consumeBudgets('user-b', ['support'])).toEqual({ ok: true });
  });
});
