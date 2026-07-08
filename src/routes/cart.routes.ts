import { Router } from 'express';
import {
  getUserCart,
  addItemToCart,
  updateItemInCart,
  removeItemFromCart,
  clearUserCart,
} from '../controllers/index.js';

import { 
  addToCartValidation,
  updateCartItemValidation,
  removeFromCartValidation
 } from '../validations/index.js';

 import { validate } from '../middlewares/validation.middleware.js';

import { optionalAuthMiddleware } from '../middlewares/auth.middleware.js';

export const cartRouter = Router();

cartRouter.get('/', optionalAuthMiddleware, getUserCart);
cartRouter.post('/', optionalAuthMiddleware, addToCartValidation, validate, addItemToCart);
cartRouter.patch('/items/:productId', optionalAuthMiddleware, updateCartItemValidation, validate, updateItemInCart);
cartRouter.delete('/items/:productId', optionalAuthMiddleware, removeFromCartValidation, validate, removeItemFromCart);
cartRouter.delete('/', optionalAuthMiddleware, clearUserCart);
