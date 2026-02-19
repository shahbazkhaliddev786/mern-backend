import type { Connection } from 'mongoose';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import config from './config.js';
import { EApplicationEnvironment } from '../constants/application.js';

let rateLimiter: RateLimiterMongo | null = null;

const RATE_LIMIT_POINTS = 100; // max requests (tokens)
const RATE_LIMIT_DURATION = 60; // per 60 seconds (bucket refills)

export const initRateLimiter = (mongooseConnection: Connection) => {
  if (config.ENV === EApplicationEnvironment.DEVELOPMENT) {
    return;
  }

  rateLimiter = new RateLimiterMongo({
    storeClient: mongooseConnection,
    keyPrefix: 'rl',
    points: RATE_LIMIT_POINTS,     // Max 100 requests
    duration: RATE_LIMIT_DURATION, // Per 60 seconds
    blockDuration: 60,             // Block for 60s if exceeded (optional but recommended)
  });
};

export const getRateLimiter = (): RateLimiterMongo | null => rateLimiter;