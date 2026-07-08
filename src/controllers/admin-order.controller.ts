import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  getAllOrdersService,
  getOrderById,
  updateOrderStatus,
  deleteOrder,
  adminUpdateOrderDetailsService,
} from '../services/index.js';

// GET /api/v1/admin/orders
export const getAllOrders = asyncHandler(async (req: Request, res: Response) => {
  const { search, status, page = '1', limit = '20' } = req.query;

  const queryParams: Parameters<typeof getAllOrdersService>[0] = {
    page: Number(page),
    limit: Number(limit),
  };

  if (search) queryParams.search = String(search);
  if (status) queryParams.status = String(status);

  const result = await getAllOrdersService(queryParams);

  return apiResponse(res, 200, 'success', 'Orders retrieved successfully', result);
});

// GET /api/v1/admin/orders/:orderId
export const getAdminOrder = asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.params;

  const order = await getOrderById(orderId as string);

  return apiResponse(res, 200, 'success', 'Order retrieved successfully', order);
});

// PATCH /api/v1/admin/orders/:orderId/status
export const adminUpdateOrderStatus = asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { status } = req.body;

  const order = await updateOrderStatus(orderId as string, status);

  logger.info('Admin updated order status', { orderId, status });

  return apiResponse(res, 200, 'success', 'Order status updated successfully', order);
});

// PATCH /api/v1/admin/orders/:orderId
export const adminUpdateOrderDetails = asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const { shippingAddress, tax, shipping, items } = req.body;

  const order = await adminUpdateOrderDetailsService(orderId as string, {
    shippingAddress,
    tax,
    shipping,
    items,
  });

  logger.info('Admin updated order details', { orderId });

  return apiResponse(res, 200, 'success', 'Order updated successfully', order);
});

// DELETE /api/v1/admin/orders/:orderId
export const adminDeleteOrder = asyncHandler(async (req: Request, res: Response) => {
  const { orderId } = req.params;

  await deleteOrder(orderId as string);

  logger.info('Admin deleted order', { orderId });

  return apiResponse(res, 200, 'success', 'Order deleted successfully');
});
