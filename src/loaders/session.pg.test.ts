// Login sessions in Postgres (spec 023): a guest cart kept between requests by connect-pg-simple.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { getDb } from '../db/client';
import { sessions } from '../db/schema/index';
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import { sessionMiddleware } from './session';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

describe.skipIf(!TEST_DATABASE_URL)('sessions on Postgres', () => {
  let testDb: TestDatabase;
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    testDb = await createTestDatabase('sessions');
    const app = express();
    app.use(sessionMiddleware());
    app.post('/cart', (req, res) => {
      req.session.cart = { items: [{ product: 'p-1', quantity: 2 }] };
      res.json({ ok: true });
    });
    app.get('/cart', (req, res) => {
      res.json(req.session.cart ?? null);
    });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    server?.close();
    await testDb?.drop();
  });

  it('keeps a guest cart between requests, in the session table', async () => {
    const added = await fetch(`${base}/cart`, { method: 'POST' });
    const cookie = added.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^connect\.sid=/);

    const again = await fetch(`${base}/cart`, { headers: { cookie: cookie! } });
    expect(await again.json()).toEqual({ items: [{ product: 'p-1', quantity: 2 }] });

    // Another visitor has their own, empty session.
    expect(await (await fetch(`${base}/cart`)).json()).toBeNull();

    const stored = await getDb().select().from(sessions);
    const withCart = stored.filter((row) => JSON.stringify(row.sess).includes('p-1'));
    expect(withCart).toHaveLength(1);
    // It lasts as long as the cookie: 30 days.
    expect(withCart[0]!.expire.getTime() - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });
});
