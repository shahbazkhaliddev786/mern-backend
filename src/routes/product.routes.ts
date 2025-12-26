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
  productIdParamValidation,
} from '../validations/product.validations.js';

import { validate } from '../middlewares/validation.middleware.js';
import { requireRole } from '../middlewares/admin.js';

export const productRouter = Router();

// CREATE - POST /api/v1/products
// Multipart form-data with field "files" for images (up to 10)
productRouter.post(
  '/',
  uploadMultipleFiles,
  createProductValidation,
  validate,
  requireRole(['admin']),
  createProduct
);

// GET ALL - GET /api/v1/products
productRouter.get('/', getProducts);

// GET, UPDATE, DELETE by ID
productRouter
  .route('/:id')
  .get(productIdParamValidation, validate, getProduct)
  .patch(
    uploadMultipleFiles,
    productIdParamValidation,
    updateProductValidation,
    validate,
    requireRole(['admin']),
    updateProduct
  )
  .delete(productIdParamValidation, validate, requireRole(['admin']), deleteProduct);
