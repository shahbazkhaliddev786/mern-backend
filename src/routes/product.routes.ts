import { Router } from 'express';
import {
  createProduct,
  getProducts,
  getProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/index.js'; 

import {uploadMultipleFiles} from '../middlewares/multer.middleware.js';

import {
  createProductValidation,
  updateProductValidation,
  IdValidation,
} from '../validations/index.js';

import { validate } from '../middlewares/validation.middleware.js';
import { requireRole } from '../middlewares/admin.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';

export const productRouter = Router();

// CREATE - POST /api/v1/products
// Multipart form-data with field "files" for images (up to 10)
productRouter.post(
  '/',
  authMiddleware,
  requireRole(['admin']),
  uploadMultipleFiles,
  createProductValidation,
  validate,
  createProduct
);

// GET ALL - GET /api/v1/products
productRouter.get('/', getProducts);

// GET, UPDATE, DELETE by ID
productRouter
  .route('/:id')
  .get(IdValidation, validate, getProduct)
  .patch(
    authMiddleware,
    requireRole(['admin']),
    uploadMultipleFiles,
    IdValidation,
    updateProductValidation,
    validate,
    updateProduct
  )
  .delete(authMiddleware, requireRole(['admin']), IdValidation, validate, deleteProduct);
