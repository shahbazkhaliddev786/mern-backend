import type { Request, Response, NextFunction } from 'express';
import { getRateLimiter } from '../config/rate.limiter.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import { RATE_LIMIT_POINTS } from '../constants/application.js';

const rateLimiterMiddleware: (req: Request, res: Response, next: NextFunction) => Promise<void> = async (
  req,
  res,
  next
) => {
  const rateLimiter = getRateLimiter();

  // Bypass if not initialized (dev mode or startup)
  if (!rateLimiter) {
    return next();
  }

  const key = req.ip || 'unknown-ip';

  try {
   
    const rlRes = await rateLimiter.consume(key);

    // Standard rate limit headers
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_POINTS);
    res.setHeader('X-RateLimit-Remaining', rlRes.remainingPoints);
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + rlRes.msBeforeNext).toISOString());

    next();
  } catch (rlRejected) {
    // Type guard: check if it's a RateLimiterRes object
    if (rlRejected && typeof rlRejected === 'object' && 'remainingPoints' in rlRejected && 'msBeforeNext' in rlRejected) {
      const rejected = rlRejected as { remainingPoints: number; msBeforeNext: number };

      res.setHeader('Retry-After', Math.ceil(rejected.msBeforeNext / 1000));

      logger.warn('Rate limit exceeded', {
        ip: key,
        remainingPoints: rejected.remainingPoints,
        msBeforeNext: rejected.msBeforeNext,
      });

      return apiResponse(res, 429, 'error', 'Too many requests. Please try again later.');
    }

    // Unexpected error (e.g., MongoDB down)
    logger.error('Rate limiter internal error', { error: rlRejected, ip: key });
    return apiResponse(res, 500, 'error', 'Internal rate limiting error');
  }
};

export default rateLimiterMiddleware;