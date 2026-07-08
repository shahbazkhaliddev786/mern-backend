import type { Request, Response, NextFunction } from 'express';
import { apiResponse } from '../utils/api.response.js';
import jwt from 'jsonwebtoken';
import config from '../config/config.js';
import { User } from '../models/auth.model.js';
import logger from '../utils/logger.js';

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return apiResponse(res, 401, 'error', 'Access denied. No token provided.');
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return apiResponse(res, 401, 'error', 'Invalid token format');
    }

    const payload = jwt.verify(token, config.JWT_SECRET as string) as { userId: string };

    const user = await User.findById(payload.userId).select('-password -refreshTokens');
    if (!user) {
      return apiResponse(res, 401, 'error', 'Invalid token — user not found');
    }

    // Attach user to request
    (req as any).user = {
      _id: user._id,
      email: user.email,
      name: user.name,
      profile: user.profile,
      role: user.role,
    };

    next();
  } catch (error: any) {
    logger.warn('Authentication failed', { error: error.message });

    if (error.name === 'TokenExpiredError') {
      return apiResponse(res, 401, 'error', 'Token expired');
    }

    if (error.name === 'JsonWebTokenError') {
      return apiResponse(res, 401, 'error', 'Invalid token');
    }

    return apiResponse(res, 401, 'error', 'Authentication failed');
  }
};

/**
 * Like authMiddleware, but allows guests through instead of rejecting them.
 * No Authorization header → proceeds as a guest (no req.user attached).
 * A present-but-invalid/expired token is still rejected with 401 — a broken
 * token should not be silently downgraded to a guest request.
 */
export const optionalAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  return authMiddleware(req, res, next);
};