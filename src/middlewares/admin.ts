import type { Request, Response, NextFunction } from 'express';
import { apiResponse } from '../utils/api.response.js';

export const requireRole = (allowedRoles: ('user' | 'admin')[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;

    if (!user || !allowedRoles.includes(user.role)) {
      return apiResponse(res, 403, 'error', 'Insufficient permissions');
    }

    next();
  };
};