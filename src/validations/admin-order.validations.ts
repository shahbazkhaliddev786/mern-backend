import { body, param } from 'express-validator';

export const orderIdParamValidation = [
  param('orderId').isMongoId().withMessage('Valid order ID is required'),
];

// Correct status enum — matches the Order model's real schema
// (the existing consumer-facing updateOrderStatusValidation does not).
export const adminUpdateOrderStatusValidation = [
  param('orderId').isMongoId().withMessage('Valid order ID is required'),
  body('status')
    .isIn(['pending', 'processing', 'shipped', 'delivered', 'cancelled'])
    .withMessage('Status must be pending, processing, shipped, delivered, or cancelled'),
];

// Full order-details edit: shipping address, tax/shipping, and/or the item list.
// All fields are optional/independent — send only what you want to change.
export const adminUpdateOrderDetailsValidation = [
  param('orderId').isMongoId().withMessage('Valid order ID is required'),

  body('shippingAddress').optional().isObject().withMessage('shippingAddress must be an object'),
  body('shippingAddress.fullName').optional().trim().notEmpty().withMessage('fullName cannot be empty'),
  body('shippingAddress.address').optional().trim().notEmpty().withMessage('address cannot be empty'),
  body('shippingAddress.city').optional().trim().notEmpty().withMessage('city cannot be empty'),
  body('shippingAddress.postalCode').optional().trim(),
  body('shippingAddress.country').optional().trim(),
  body('shippingAddress.phone').optional().trim(),

  body('tax').optional().isFloat({ min: 0 }).withMessage('Tax must be a non-negative number'),
  body('shipping').optional().isFloat({ min: 0 }).withMessage('Shipping must be a non-negative number'),

  body('items').optional().isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.product').if(body('items').exists()).isMongoId().withMessage('Each item needs a valid product ID'),
  body('items.*.quantity')
    .if(body('items').exists())
    .isInt({ min: 1 })
    .withMessage('Each item quantity must be at least 1'),
];
