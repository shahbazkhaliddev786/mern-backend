import { Router } from 'express';
import { getDashboardSummary } from '../controllers/index.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';

export const adminDashboardRouter = Router();

adminDashboardRouter.use(authMiddleware, requireRole(['admin']));

// GET /api/v1/admin/dashboard/summary - live stats, trends, and revenue series
adminDashboardRouter.get('/summary', getDashboardSummary);
