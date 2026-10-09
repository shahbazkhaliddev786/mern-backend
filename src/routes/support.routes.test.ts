import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import config from '../config/config';
import { supportRouter } from './support.routes';

// Stand-in for the Make.com webhook: records every request it receives.
let received: unknown[] = [];
let webhookStatus = 200;
const webhook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push(JSON.parse(body));
    res.writeHead(webhookStatus).end();
  });
});

const app = express();
app.use(express.json());
// Stand-in for a verified session: requests carrying x-test-user are signed in.
app.use((req, _res, next) => {
  if (req.headers['x-test-user']) {
    (req as any).user = { _id: 'user-1', name: 'Session User', email: 'session@example.com' };
  }
  next();
});
app.use('/support', supportRouter);
const server = http.createServer(app);

const listen = (target: http.Server) =>
  new Promise<number>((resolve) => target.listen(0, () => resolve((target.address() as AddressInfo).port)));

let supportUrl = '';

beforeAll(async () => {
  config.SUPPORT_WEBHOOK_URL = `http://127.0.0.1:${await listen(webhook)}`;
  supportUrl = `http://127.0.0.1:${await listen(server)}/support`;
});

afterAll(() => {
  webhook.close();
  server.close();
});

beforeEach(() => {
  received = [];
  webhookStatus = 200;
});

const content = { subject: 'Order question', message: 'Where is my order #1234?' };

const post = (body: object, signedIn = false) =>
  fetch(supportUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signedIn ? { 'x-test-user': '1' } : {}) },
    body: JSON.stringify(body),
  });

describe('POST /api/v1/support', () => {
  it('forwards a guest request with the name and email they entered', async () => {
    const res = await post({ name: 'Guest User', email: 'guest@example.com', ...content });

    expect(res.status).toBe(200);
    expect(received).toEqual([
      { name: 'Guest User', email: 'guest@example.com', ...content, userId: null, source: 'contact_form' },
    ]);
  });

  it('uses the session identity for a signed-in user, ignoring name/email in the body', async () => {
    const res = await post({ name: 'CEO', email: 'ceo@aljo.store', ...content }, true);

    expect(res.status).toBe(200);
    expect(received).toEqual([
      { name: 'Session User', email: 'session@example.com', ...content, userId: 'user-1', source: 'contact_form' },
    ]);
  });

  it('rejects a guest request without a name and email', async () => {
    const res = await post(content);

    expect(res.status).toBe(400);
    expect(received).toEqual([]);
  });

  it('responds 502 when the webhook fails', async () => {
    webhookStatus = 500;

    const res = await post(content, true);

    expect(res.status).toBe(502);
  });

  it('responds 503 when no webhook is configured', async () => {
    const url = config.SUPPORT_WEBHOOK_URL;
    config.SUPPORT_WEBHOOK_URL = '';
    try {
      const res = await post(content, true);

      expect(res.status).toBe(503);
      expect(received).toEqual([]);
    } finally {
      config.SUPPORT_WEBHOOK_URL = url;
    }
  });
});
