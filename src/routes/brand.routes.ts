import { Router } from 'express';
import {
  createBrand,
  getBrands,
  getBrand,
  updateBrand,
  deleteBrand,
} from '../controllers/index.js';

import {
  createBrandValidation,
  updateBrandValidation,
  IdValidation
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';

export const brandRouter = Router();

// POST /api/brands - Create a new brand (admin only)
brandRouter.post('/', authMiddleware, requireRole(['admin']), createBrandValidation, validate, createBrand);

// GET /api/brands - Get all brands
brandRouter.get('/', getBrands);

// GET /api/brands/:id - Get brand by ID
// PUT /api/brands/:id - Update brand (admin only)
// DELETE /api/brands/:id - Delete brand (admin only)
brandRouter
  .route('/:id')
  .get(
    IdValidation,
    validate,
    getBrand
  )
  .put(
    authMiddleware,
    requireRole(['admin']),
    IdValidation,
    updateBrandValidation,
    validate,
    updateBrand
  )
  .delete(
    authMiddleware,
    requireRole(['admin']),
    IdValidation,
    validate,
    deleteBrand
  );
