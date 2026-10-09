
import { body } from 'express-validator';

// Checkout body (shipping address) is validated server-side with zod via
// validateBody(shippingSchema); tax/shipping are no longer accepted from the
// client — they're computed in pricing.service.ts. See order.routes.ts.

export const updateOrderStatusValidation = [
  body('status')
    .isIn(['pending', 'processing', 'shipped', 'delivered', 'cancelled'])
    .withMessage('Status must be pending, processing, shipped, delivered, or cancelled'),
];
