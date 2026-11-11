// The daily cleanup's endpoint (spec 023): only Vercel Cron's secret runs it.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import config from '../config/config';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import { internalRouter } from './internal.routes';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

describe.skipIf(!TEST_DATABASE_URL)('GET /api/v1/internal/cleanup', () => {
  let testDb: TestDatabase;
  let server: http.Server;
  let url = '';
  const secret = config.CRON_SECRET;

  beforeAll(async () => {
    testDb = await createTestDatabase('internal_routes');
    const app = express();
    app.use('/api/v1/internal', internalRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/internal/cleanup`;
  }, 60_000);

  afterAll(async () => {
    config.CRON_SECRET = secret;
    server?.close();
    await testDb?.drop();
  });

  const call = (authorization?: string) => fetch(url, { headers: authorization ? { authorization } : {} });

  it('refuses a call without the secret, or with a wrong one', async () => {
    config.CRON_SECRET = 'test-cron-secret';
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong-secret')).status).toBe(401);
    expect((await call('test-cron-secret')).status).toBe(401);
  });

  it('refuses every call while CRON_SECRET is not set', async () => {
    config.CRON_SECRET = '';
    expect((await call('Bearer ')).status).toBe(401);
    expect((await call('Bearer undefined')).status).toBe(401);
  });

  it('runs the cleanup with the secret and answers with counts only', async () => {
    config.CRON_SECRET = 'test-cron-secret';
    const response = await call('Bearer test-cron-secret');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; data: { removed: Record<string, number> } };
    expect(body.status).toBe('success');
    expect(body.data.removed).toMatchObject({ otps: 0, session: 0, rate_limits: 0, conversations: 0 });
  });
});
