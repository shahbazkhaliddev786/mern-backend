// Jobs the platform runs, not people (spec 023).
// GET /api/v1/internal/cleanup: the daily sweep of expired records, called by Vercel Cron, which
// sends `Authorization: Bearer <CRON_SECRET>`. While CRON_SECRET isn't set, every call is refused.

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import config from '../config/config.js';
import { describeError } from '../db/client.js';
import { cleanupDatabase } from '../db/cleanup.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';

/** Compares in constant time, so the secret can't be guessed from how long a refusal takes. */
function carriesSecret(header: string | undefined, secret: string): boolean {
  if (!secret) return false;
  const given = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export const internalRouter = Router();

internalRouter.get('/cleanup', async (req: Request, res: Response) => {
  if (!carriesSecret(req.headers.authorization, config.CRON_SECRET)) return apiResponse(res, 401, 'error', 'Unauthorized');
  try {
    const removed = await cleanupDatabase();
    logger.info('DB_CLEANUP', { removed });
    return apiResponse(res, 200, 'success', 'Expired records deleted', { removed });
  } catch (error) {
    logger.error('DB_CLEANUP_FAILED', { error: describeError(error) });
    return apiResponse(res, 500, 'error', 'Cleanup failed');
  }
});
