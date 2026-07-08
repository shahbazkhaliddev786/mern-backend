import { Router } from 'express';
import {
  getAllOrders,
  getAdminOrder,
  adminUpdateOrderStatus,
  adminUpdateOrderDetails,
  adminDeleteOrder,
} from '../controllers/index.js';
import {
  orderIdParamValidation,
  adminUpdateOrderStatusValidation,
  adminUpdateOrderDetailsValidation,
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';

export const adminOrderRouter = Router();

adminOrderRouter.use(authMiddleware, requireRole(['admin']));

// GET /api/v1/admin/orders - list all orders (search + status filter + pagination)
adminOrderRouter.get('/', getAllOrders);

// GET /api/v1/admin/orders/:orderId - view one order
adminOrderRouter.get('/:orderId', orderIdParamValidation, validate, getAdminOrder);

// PATCH /api/v1/admin/orders/:orderId/status - update fulfillment status
adminOrderRouter.patch(
  '/:orderId/status',
  adminUpdateOrderStatusValidation,
  validate,
  adminUpdateOrderStatus
);

// PATCH /api/v1/admin/orders/:orderId - edit shipping address, tax/shipping, and/or items
adminOrderRouter.patch(
  '/:orderId',
  adminUpdateOrderDetailsValidation,
  validate,
  adminUpdateOrderDetails
);

// DELETE /api/v1/admin/orders/:orderId - delete order
adminOrderRouter.delete('/:orderId', orderIdParamValidation, validate, adminDeleteOrder);
