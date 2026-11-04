import { body, param } from 'express-validator';

export const userIdParamValidation = [
  param('userId').isUUID().withMessage('Valid user ID is required'),
];

export const cartItemParamValidation = [
  param('userId').isUUID().withMessage('Valid user ID is required'),
  param('productId').isUUID().withMessage('Valid product ID is required'),
];

export const adminUpdateCartItemValidation = [
  param('userId').isUUID().withMessage('Valid user ID is required'),
  param('productId').isUUID().withMessage('Valid product ID is required'),
  body('quantity').isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
];
