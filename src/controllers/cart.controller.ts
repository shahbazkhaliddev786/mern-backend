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
  getGuestCart,
  addToGuestCart,
  updateGuestCartItem,
  removeFromGuestCart,
  clearGuestCart,
} from '../services/index.js';

import type {
  AddToCartBody,
  UpdateCartItemBody,
  CartItemParams
} from '../types/index.js';

// Signed-in users have a DB cart keyed by their id; guests keep theirs in the session.
const signedInUserId = (req: Request<any>): string | undefined => (req as any).user?._id?.toString();

// Get user cart
export const getUserCart = asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = signedInUserId(req);
    const cart = userId ? await getCart(userId) : await getGuestCart(req.session);

    logger.info('Cart retrieved successfully', {
      userId: (req as any).user?._id || 'guest',
      itemCount: cart.items ? cart.items.length : 0,
    });
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
    const userId = signedInUserId(req);
    const cart = userId
      ? await addToCart(userId, productId, quantity)
      : await addToGuestCart(req.session, productId, quantity);

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
    const userId = signedInUserId(req);
    const cart = userId
      ? await updateCartItem(userId, productId, Number(quantity))
      : await updateGuestCartItem(req.session, productId, Number(quantity));

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
    const userId = signedInUserId(req);
    const cart = userId ? await removeFromCart(userId, productId) : await removeFromGuestCart(req.session, productId);

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
    const userId = signedInUserId(req);
    const cart = userId ? await clearCart(userId) : await clearGuestCart(req.session);

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

