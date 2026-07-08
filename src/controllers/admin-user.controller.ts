import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  getAllUsersService,
  adminUpdateUserRoleService,
  adminDeleteUserService,
  getUserById,
} from '../services/index.js';

// GET /api/v1/admin/users
export const getAllUsers = asyncHandler(async (req: Request, res: Response) => {
  const { search, role, page = '1', limit = '20' } = req.query;

  const queryParams: Parameters<typeof getAllUsersService>[0] = {
    page: Number(page),
    limit: Number(limit),
  };

  if (search) queryParams.search = String(search);
  if (role) queryParams.role = String(role);

  const result = await getAllUsersService(queryParams);

  return apiResponse(res, 200, 'success', 'Users retrieved successfully', result);
});

// GET /api/v1/admin/users/:userId
export const getAdminUser = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

  const user = await getUserById(userId as string);
  if (!user) {
    return apiResponse(res, 404, 'error', 'User not found');
  }

  return apiResponse(res, 200, 'success', 'User retrieved successfully', {
    id: user._id,
    name: user.name,
    email: user.email,
    profile: user.profile,
    role: user.role,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
  });
});

// PATCH /api/v1/admin/users/:userId/role
export const adminUpdateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const { role } = req.body;
  const requestingAdminId = (req as any).user._id.toString();

  const user = await adminUpdateUserRoleService(requestingAdminId, userId as string, role);

  logger.info('Admin updated user role', { userId, role, by: requestingAdminId });

  return apiResponse(res, 200, 'success', 'User role updated successfully', user);
});

// DELETE /api/v1/admin/users/:userId
export const adminDeleteUser = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;
  const requestingAdminId = (req as any).user._id.toString();

  await adminDeleteUserService(requestingAdminId, userId as string);

  logger.info('Admin deleted user', { userId, by: requestingAdminId });

  return apiResponse(res, 200, 'success', 'User deleted successfully');
});
