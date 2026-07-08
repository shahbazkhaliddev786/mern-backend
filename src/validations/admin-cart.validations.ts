import { body, param } from 'express-validator';

export const userIdParamValidation = [
  param('userId').isMongoId().withMessage('Valid user ID is required'),
];

export const cartItemParamValidation = [
  param('userId').isMongoId().withMessage('Valid user ID is required'),
  param('productId').isMongoId().withMessage('Valid product ID is required'),
];

export const adminUpdateCartItemValidation = [
  param('userId').isMongoId().withMessage('Valid user ID is required'),
  param('productId').isMongoId().withMessage('Valid product ID is required'),
  body('quantity').isInt({ min: 0 }).withMessage('Quantity must be a non-negative integer'),
];
