import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import { getDashboardSummaryService } from '../services/index.js';

// GET /api/v1/admin/dashboard/summary
export const getDashboardSummary = asyncHandler(async (_req: Request, res: Response) => {
  const summary = await getDashboardSummaryService();

  return apiResponse(res, 200, 'success', 'Dashboard summary retrieved successfully', summary);
});
