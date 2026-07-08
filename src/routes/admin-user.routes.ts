import { Router } from 'express';
import {
  getAllUsers,
  getAdminUser,
  adminUpdateUserRole,
  adminDeleteUser,
} from '../controllers/index.js';
import {
  adminUserIdParamValidation,
  adminUpdateUserRoleValidation,
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';

export const adminUserRouter = Router();

adminUserRouter.use(authMiddleware, requireRole(['admin']));

// GET /api/v1/admin/users - list all users (search + role filter + pagination)
adminUserRouter.get('/', getAllUsers);

// GET /api/v1/admin/users/:userId - view one user
adminUserRouter.get('/:userId', adminUserIdParamValidation, validate, getAdminUser);

// PATCH /api/v1/admin/users/:userId/role - change role
adminUserRouter.patch(
  '/:userId/role',
  adminUpdateUserRoleValidation,
  validate,
  adminUpdateUserRole
);

// DELETE /api/v1/admin/users/:userId - delete user
adminUserRouter.delete('/:userId', adminUserIdParamValidation, validate, adminDeleteUser);
