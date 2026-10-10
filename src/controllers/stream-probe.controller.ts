import type { Request, Response } from 'express';
import { apiResponse } from '../utils/api.response.js';

// TEMPORARY (spec 004): measures whether a long server-sent-events response streams on
// Vercel. Sends a timestamped `tick` every second for N seconds, then `done`. Mounted only
// when STREAM_PROBE_ENABLED=true; deleted when spec 004 closes.

export const PROBE_MAX_SECONDS = 300;
const KEEPALIVE_MS = 15_000;

export const streamProbe = (req: Request, res: Response): void => {
  const raw = req.query.seconds ?? '30';
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PROBE_MAX_SECONDS) {
    return apiResponse(res, 400, 'error', `seconds must be a whole number from 1 to ${PROBE_MAX_SECONDS}`);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(': open\n\n'); // first bytes right away, so time-to-first-byte is measurable

  const started = Date.now();
  let i = 0;
  const stop = () => {
    clearInterval(tick);
    clearInterval(keepalive);
  };
  const tick = setInterval(() => {
    i += 1;
    res.write(`event: tick\ndata: ${JSON.stringify({ i, serverTs: Date.now() })}\n\n`);
    if (i >= seconds) {
      stop();
      res.write(`event: done\ndata: ${JSON.stringify({ elapsedMs: Date.now() - started })}\n\n`);
      res.end();
    }
  }, 1000);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
  // The client left: stop writing.
  res.on('close', stop);
};
