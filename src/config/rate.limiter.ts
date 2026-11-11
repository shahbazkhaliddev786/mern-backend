import { getTableName } from 'drizzle-orm';
import { RateLimiterPostgres } from 'rate-limiter-flexible';
import config from './config.js';
import { EApplicationEnvironment } from '../constants/application.js';
import { getPool } from '../db/client.js';
import { rateLimits } from '../db/schema/index.js';

let rateLimiter: RateLimiterPostgres | null = null;

const RATE_LIMIT_POINTS = 100; // max requests (tokens)
const RATE_LIMIT_DURATION = 60; // per 60 seconds (bucket refills)

// Created on first use rather than at startup, so every entry point gets it —
// the Vercel handler (api/index.ts) never ran the old startup init, which left
// production unthrottled. Counters live in Postgres (spec 023), in the table
// the migrations make. Still off in development.
export const getRateLimiter = (): RateLimiterPostgres | null => {
  if (!rateLimiter && config.ENV !== EApplicationEnvironment.DEVELOPMENT) {
    rateLimiter = new RateLimiterPostgres({
      storeClient: getPool(),
      storeType: 'pool',
      tableName: getTableName(rateLimits),
      tableCreated: true,
      keyPrefix: 'rl',
      points: RATE_LIMIT_POINTS,     // Max 100 requests
      duration: RATE_LIMIT_DURATION, // Per 60 seconds
      blockDuration: 60,             // Block for 60s if exceeded (optional but recommended)
    });
  }
  return rateLimiter;
};
