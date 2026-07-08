import { Router } from 'express';
import {
  getAllCarts,
  getCartByUserId,
  adminUpdateCartItem,
  adminRemoveCartItem,
  adminClearCart,
} from '../controllers/index.js';
import {
  userIdParamValidation,
  cartItemParamValidation,
  adminUpdateCartItemValidation,
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';

export const adminCartRouter = Router();

adminCartRouter.use(authMiddleware, requireRole(['admin']));

// GET /api/v1/admin/carts - list all carts (search + pagination)
adminCartRouter.get('/', getAllCarts);

// GET /api/v1/admin/carts/:userId - view one user's cart
adminCartRouter.get('/:userId', userIdParamValidation, validate, getCartByUserId);

// PATCH /api/v1/admin/carts/:userId/items/:productId - change item quantity
adminCartRouter.patch(
  '/:userId/items/:productId',
  adminUpdateCartItemValidation,
  validate,
  adminUpdateCartItem
);

// DELETE /api/v1/admin/carts/:userId/items/:productId - remove one item
adminCartRouter.delete(
  '/:userId/items/:productId',
  cartItemParamValidation,
  validate,
  adminRemoveCartItem
);

// DELETE /api/v1/admin/carts/:userId - clear entire cart
adminCartRouter.delete('/:userId', userIdParamValidation, validate, adminClearCart);
