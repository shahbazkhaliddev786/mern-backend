import { Router } from 'express';
import {
  createOrder,
  updateOrder,
  deleteOrderCtrl,
  getOrders,
  getOrder,
  getMyOrdersController
} from '../controllers/index.js';
import { z } from 'zod';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';
import {
  updateOrderStatusValidation
} from '../validations/index.js';
import { shippingSchema } from '../validations/shipping.schema.js';
import { validate } from '../middlewares/validation.middleware.js';
import { validateBody } from '../middlewares/zod-validate.middleware.js';


const orderRouter = Router();

// The server recomputes items/subtotal/tax/shipping/total from the cart, so the
// only client input we validate (and keep) is the shipping address.
const checkoutBodySchema = z.object({ shippingAddress: shippingSchema });

// Create checkout session (user must be logged in for cart merge)
orderRouter.post('/checkout', authMiddleware, validateBody(checkoutBodySchema), createOrder);

// User orders
orderRouter.get('/', authMiddleware, requireRole(['user', 'admin']), getOrders);
orderRouter.get('/my-orders', authMiddleware, getMyOrdersController);
orderRouter.get('/:orderId', authMiddleware, getOrder);

// Admin only
orderRouter.patch('/:orderId/status', authMiddleware, requireRole(['admin']), updateOrderStatusValidation, validate, updateOrder);
orderRouter.delete('/:orderId', authMiddleware, requireRole(['admin']), deleteOrderCtrl);

export default orderRouter;