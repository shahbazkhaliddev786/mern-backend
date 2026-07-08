import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  getAllCartsService,
  getCartByUserIdService,
  adminUpdateCartItemService,
  adminRemoveCartItemService,
  adminClearCartService,
} from '../services/index.js';

// GET /api/v1/admin/carts
export const getAllCarts = asyncHandler(async (req: Request, res: Response) => {
  const { search, page = '1', limit = '20' } = req.query;

  const queryParams: Parameters<typeof getAllCartsService>[0] = {
    page: Number(page),
    limit: Number(limit),
  };

  if (search) queryParams.search = String(search);

  const result = await getAllCartsService(queryParams);

  return apiResponse(res, 200, 'success', 'Carts retrieved successfully', result);
});

// GET /api/v1/admin/carts/:userId
export const getCartByUserId = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

  const cart = await getCartByUserIdService(userId as string);

  return apiResponse(res, 200, 'success', 'Cart retrieved successfully', cart);
});

// PATCH /api/v1/admin/carts/:userId/items/:productId
export const adminUpdateCartItem = asyncHandler(async (req: Request, res: Response) => {
  const { userId, productId } = req.params;
  const { quantity } = req.body;

  const cart = await adminUpdateCartItemService(userId as string, productId as string, Number(quantity));

  logger.info('Admin updated cart item', { userId, productId, quantity });

  return apiResponse(res, 200, 'success', 'Cart item updated successfully', cart);
});

// DELETE /api/v1/admin/carts/:userId/items/:productId
export const adminRemoveCartItem = asyncHandler(async (req: Request, res: Response) => {
  const { userId, productId } = req.params;

  const cart = await adminRemoveCartItemService(userId as string, productId as string);

  logger.info('Admin removed cart item', { userId, productId });

  return apiResponse(res, 200, 'success', 'Item removed from cart successfully', cart);
});

// DELETE /api/v1/admin/carts/:userId
export const adminClearCart = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.params;

  const cart = await adminClearCartService(userId as string);

  logger.info('Admin cleared cart', { userId });

  return apiResponse(res, 200, 'success', 'Cart cleared successfully', cart);
});
