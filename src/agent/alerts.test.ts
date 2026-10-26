// The "staged test" for M6's alerts (spec 016): a local server stands in for the webhook.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ default: { error: log.error, warn: log.warn, info: vi.fn() } }));

import config from '../config/config';
import { raiseAlert } from './alerts';

let mode: 'ok' | 'fail' | 'hang' = 'ok';
const received: unknown[] = [];
let base = '';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    received.push(JSON.parse(body));
    if (mode === 'hang') return; // never answers
    res.writeHead(mode === 'ok' ? 200 : 500).end();
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
  config.ALERT_WEBHOOK_URL = '';
});
beforeEach(() => {
  mode = 'ok';
  received.length = 0;
  log.error.mockClear();
  log.warn.mockClear();
  config.ALERT_WEBHOOK_URL = `${base}/hook`;
});

const context = { userId: 'u1', thread: 'u1:t1:v6', tool: 'clear_cart', toolCallId: 'call_1' };

describe('raiseAlert', () => {
  it('logs the alert and posts it to the webhook, with ids only', async () => {
    await raiseAlert('unconfirmed_write', context);
    expect(log.error).toHaveBeenCalledWith('AGENT_ALERT', { kind: 'unconfirmed_write', ...context });
    expect(received).toEqual([{ text: 'Aljo agent alert: unconfirmed_write (user u1, thread u1:t1:v6, tool clear_cart)' }]);
  });

  it('only logs when no webhook is set', async () => {
    config.ALERT_WEBHOOK_URL = '';
    await raiseAlert('sensitive_in_model_output', { userId: 'u1', thread: 't' });
    expect(log.error).toHaveBeenCalledOnce();
    expect(received).toEqual([]);
  });

  it('never throws when the webhook fails', async () => {
    mode = 'fail';
    await expect(raiseAlert('sensitive_in_tool_args', context)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('AGENT_ALERT_NOT_DELIVERED', { kind: 'sensitive_in_tool_args', error: 'HTTP 500' });
  });

  it('gives up after 3 seconds when the webhook hangs', async () => {
    mode = 'hang';
    const started = Date.now();
    await expect(raiseAlert('sensitive_in_tool_result', context)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(log.warn).toHaveBeenCalledWith('AGENT_ALERT_NOT_DELIVERED', expect.objectContaining({ kind: 'sensitive_in_tool_result' }));
  }, 10_000);
});
