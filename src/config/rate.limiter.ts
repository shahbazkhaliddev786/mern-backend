import mongoose from 'mongoose';
import { RateLimiterMongo } from 'rate-limiter-flexible';
import config from './config.js';
import { EApplicationEnvironment } from '../constants/application.js';

let rateLimiter: RateLimiterMongo | null = null;

const RATE_LIMIT_POINTS = 100; // max requests (tokens)
const RATE_LIMIT_DURATION = 60; // per 60 seconds (bucket refills)

// Created on first use rather than at startup, so every entry point gets it —
// the Vercel handler (api/index.ts) never ran the old startup init, which left
// production unthrottled. Requests only arrive after connectDB(), so the
// mongoose connection is open by then. Still off in development.
export const getRateLimiter = (): RateLimiterMongo | null => {
  if (!rateLimiter && config.ENV !== EApplicationEnvironment.DEVELOPMENT) {
    rateLimiter = new RateLimiterMongo({
      storeClient: mongoose.connection,
      keyPrefix: 'rl',
      points: RATE_LIMIT_POINTS,     // Max 100 requests
      duration: RATE_LIMIT_DURATION, // Per 60 seconds
      blockDuration: 60,             // Block for 60s if exceeded (optional but recommended)
    });
  }
  return rateLimiter;
};
