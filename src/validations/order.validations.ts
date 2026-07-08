
import { body } from 'express-validator';

export const createOrderValidation = [
  body('tax')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Tax must be a positive number'),
  body('shipping')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Shipping must be a positive number'),
];

export const updateOrderStatusValidation = [
  body('status')
    .isIn(['pending', 'processing', 'shipped', 'delivered', 'cancelled'])
    .withMessage('Status must be pending, processing, shipped, delivered, or cancelled'),
];