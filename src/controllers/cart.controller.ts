
import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  getCart,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
} from '../services/index.js';

import type { 
  AddToCartBody, 
  UpdateCartItemBody, 
  CartItemParams 
} from '../types/index.js';

// Get user cart
export const getUserCart = asyncHandler(async (req: Request, res: Response) => {
  try {
    const cart = await getCart(req);

    return apiResponse(res, 200, 'success', 'Cart retrieved successfully', cart);
  } catch (error: any) {
    logger.error('Error retrieving cart', { error: error.message, userId: (req as any).user?._id || 'guest' });
    return apiResponse(res, 500, 'error', error.message || 'Failed to retrieve cart');
  }
});

// Add to cart
export const addItemToCart = asyncHandler(async (req: Request<{},{}, AddToCartBody>, res: Response) => {
  const { productId, quantity } = req.body;

  try {
    const cart = await addToCart(req, productId, quantity);

    logger.info('Item added to cart', {
      userId: (req as any).user?._id || 'guest',
      productId,
      quantity,
    });

    return apiResponse(res, 200, 'success', 'Item added to cart successfully', cart);
  } catch (error: any) {
    logger.warn('Failed to add item to cart', {
      userId: (req as any).user?._id || 'guest',
      productId,
      quantity,
      error: error.message,
    });

    return apiResponse(res, 400, 'error', error.message || 'Failed to add item to cart');
  }
});

// Update cart
export const updateItemInCart = asyncHandler(async (req: Request<CartItemParams,{}, UpdateCartItemBody>, res: Response) => {
  const { productId } = req.params;
  const { quantity } = req.body;

  try {
    if (productId === undefined) {
      throw new Error('Product ID is required');
    }
    const cart = await updateCartItem(req, productId, Number(quantity));

    logger.info('Cart item quantity updated', {
      userId: (req as any).user?._id || 'guest',
      productId,
      newQuantity: quantity,
    });

    return apiResponse(res, 200, 'success', 'Cart item updated successfully', cart);
  } catch (error: any) {
    logger.warn('Failed to update cart item', {
      userId: (req as any).user?._id || 'guest',
      productId,
      error: error.message,
    });

    return apiResponse(res, 400, 'error', error.message || 'Failed to update cart item');
  }
});

// Remove from cart
export const removeItemFromCart = asyncHandler(async (req: Request<CartItemParams,{},{}>, res: Response) => {
  const { productId } = req.params;

  try {
    if (productId === undefined) {
      throw new Error('Product ID is required');
    }
    const cart = await removeFromCart(req, productId);

    logger.info('Item removed from cart', {
      userId: (req as any).user?._id || 'guest',
      productId,
    });

    return apiResponse(res, 200, 'success', 'Item removed from cart successfully', cart);
  } catch (error: any) {
    logger.warn('Failed to remove item from cart', {
      userId: (req as any).user?._id || 'guest',
      productId,
      error: error.message,
    });

    return apiResponse(res, 400, 'error', error.message || 'Failed to remove item from cart');
  }
});

// Clear cart
export const clearUserCart = asyncHandler(async (req: Request, res: Response) => {
  try {
    const cart = await clearCart(req);

    logger.info('Cart cleared successfully', {
      userId: (req as any).user?._id || 'guest',
    });

    return apiResponse(res, 200, 'success', 'Cart cleared successfully', cart);
  } catch (error: any) {
    logger.error('Failed to clear cart', {
      userId: (req as any).user?._id || 'guest',
      error: error.message,
    });

    return apiResponse(res, 500, 'error', 'Failed to clear cart');
  }
});

