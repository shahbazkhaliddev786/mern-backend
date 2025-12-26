import { Router } from 'express';
import {
  createOrder,
  updateOrder,
  deleteOrderCtrl,
  getOrders,
  getOrder,
} from '../controllers/index.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';
import { 
  createOrderValidation,
  updateOrderStatusValidation 
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';


const orderRouter = Router();

// Create checkout session (user must be logged in for cart merge)
orderRouter.post('/checkout', authMiddleware, createOrderValidation, validate, createOrder);

// User orders
orderRouter.get('/', authMiddleware, requireRole(['user', 'admin']), getOrders);
orderRouter.get('/:orderId', authMiddleware, getOrder);

// Admin only
orderRouter.patch('/:orderId/status', authMiddleware, requireRole(['user', 'admin']), updateOrderStatusValidation, updateOrder);
orderRouter.delete('/:orderId', authMiddleware, requireRole(['admin']), deleteOrderCtrl);

export default orderRouter;