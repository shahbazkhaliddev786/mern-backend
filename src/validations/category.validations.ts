import { body } from 'express-validator';

export const createCategoryValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Category name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Category name must be between 2 and 100 characters')
    .bail(),
];

export const updateCategoryValidation = [
  body('name')
    .trim()
    .optional()
    .isLength({ min: 2, max: 100 })
    .withMessage('Category name must be between 2 and 100 characters')
    .bail(),
];

