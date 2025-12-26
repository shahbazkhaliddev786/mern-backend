import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import {
  createCheckoutSession,
  updateOrderStatus,
  deleteOrder,
  getUserOrders,
  getOrderById,
} from '../services/index.js';

import type {   
  UpdateOrderBody,
  OrderParams
} from '../types/index.js';

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  const { sessionId, url } = await createCheckoutSession(req);

  return apiResponse(res, 200, 'success', 'Checkout session created', {
    sessionId,
    success_url: url,
  });
});

export const updateOrder = asyncHandler(async (req: Request<OrderParams, {}, UpdateOrderBody>, res: Response) => {
  const { orderId } = req.params;
  const { status } = req.body;

  if (!orderId) {
    return apiResponse(res, 400, 'error', 'Order ID is required');
  }

  const order = await updateOrderStatus(orderId, status);

  return apiResponse(res, 200, 'success', 'Order status updated', order);
});

export const deleteOrderCtrl = asyncHandler(async (req: Request<OrderParams, {}, {}>, res: Response) => {
  const { orderId } = req.params;

    if (!orderId) { 
        return apiResponse(res, 400, 'error', 'Order ID is required');
    }

  await deleteOrder(orderId);

  return apiResponse(res, 200, 'success', 'Order deleted successfully');
});

export const getOrders = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).user._id;
  const orders = await getUserOrders(userId);

  return apiResponse(res, 200, 'success', 'Orders retrieved', orders);
});

export const getOrder = asyncHandler(async (req: Request<OrderParams, {}, {}>, res: Response) => {
  const { orderId } = req.params;

    if (!orderId) {
        return apiResponse(res, 400, 'error', 'Order ID is required');
    }

  const order = await getOrderById(orderId);

  return apiResponse(res, 200, 'success', 'Order retrieved', order);
});