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

import { authMiddleware } from '../middlewares/auth.middleware.js';

export const cartRouter = Router();

cartRouter.get('/', authMiddleware, getUserCart);                    
cartRouter.post('/', authMiddleware, addToCartValidation, validate, addItemToCart);                 
cartRouter.patch('/items/:productId', authMiddleware, updateCartItemValidation, validate, updateItemInCart); 
cartRouter.delete('/items/:productId', authMiddleware, removeFromCartValidation, validate, removeItemFromCart); 
cartRouter.delete('/', authMiddleware, clearUserCart);           
