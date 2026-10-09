import { param } from 'express-validator';

// Cart request bodies are validated with zod (cart.schema.ts), which the agent's
// cart tools share; only the :productId route param is checked here.
export const productIdParamValidation = [
  param('productId')
    .isMongoId()
    .withMessage('Valid product ID is required'),
];
