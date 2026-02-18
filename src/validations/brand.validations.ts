import { body } from 'express-validator';

export const createBrandValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Brand name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Brand name must be between 2 and 100 characters')
    .bail(),
];

export const updateBrandValidation = [
  body('name')
    .trim()
    .optional()
    .isLength({ min: 2, max: 100 })
    .withMessage('Brand name must be between 2 and 100 characters')
    .bail(),
];
