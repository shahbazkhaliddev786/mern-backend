import { Router } from 'express';
import {
  getUserCart,
  addItemToCart,
  updateItemInCart,
  removeItemFromCart,
  clearUserCart,
} from '../controllers/index.js';

import { productIdParamValidation } from '../validations/index.js';
import { addToCartSchema, updateCartItemSchema } from '../validations/cart.schema.js';

import { validate } from '../middlewares/validation.middleware.js';
import { validateBody } from '../middlewares/zod-validate.middleware.js';

import { optionalAuthMiddleware } from '../middlewares/auth.middleware.js';

export const cartRouter = Router();

cartRouter.get('/', optionalAuthMiddleware, getUserCart);
cartRouter.post('/', optionalAuthMiddleware, validateBody(addToCartSchema), addItemToCart);
cartRouter.patch('/items/:productId', optionalAuthMiddleware, productIdParamValidation, validate, validateBody(updateCartItemSchema), updateItemInCart);
cartRouter.delete('/items/:productId', optionalAuthMiddleware, productIdParamValidation, validate, removeItemFromCart);
cartRouter.delete('/', optionalAuthMiddleware, clearUserCart);
