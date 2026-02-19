import { body, param } from 'express-validator';

// CREATE PRODUCT - All fields validated (images handled separately by multer)
export const createProductValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Product name is required')
    .isLength({ min: 2, max: 200 })
    .withMessage('Product name must be between 2 and 200 characters'),

  body('description')
    .trim()
    .notEmpty()
    .withMessage('Description is required')
    .isLength({ min: 10 })
    .withMessage('Description must be at least 10 characters long'),

  body('price')
    .isFloat({ min: 0.01 })
    .withMessage('Price must be a positive number greater than 0'),

  body('stock')
    .isInt({ min: 0 })
    .withMessage('Stock must be a non-negative integer'),

  body('category')
    .isMongoId()
    .withMessage('Valid category ID is required'),

  body('brand')
    .isMongoId()
    .withMessage('Valid brand ID is required'),
];

// UPDATE PRODUCT
export const updateProductValidation = [
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Product name cannot be empty')
    .isLength({ min: 2, max: 200 })
    .withMessage('Product name must be between 2 and 200 characters'),

  body('description')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Description cannot be empty')
    .isLength({ min: 10 })
    .withMessage('Description must be at least 10 characters long'),

  body('price')
    .optional()
    .isFloat({ min: 0.01 })
    .withMessage('Price must be a positive number greater than 0'),

  body('stock')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Stock must be a non-negative integer'),

  body('category')
    .optional()
    .isMongoId()
    .withMessage('Valid category ID is required'),

  body('brand')
    .optional()
    .isMongoId()
    .withMessage('Valid brand ID is required'),
];
