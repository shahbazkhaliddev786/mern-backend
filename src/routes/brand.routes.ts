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

export const brandRouter = Router();

// POST /api/brands - Create a new brand
brandRouter.post('/', createBrandValidation, validate, createBrand);

// GET /api/brands - Get all brands
brandRouter.get('/', getBrands);

// GET /api/brands/:id - Get brand by ID
// PUT /api/brands/:id - Update brand
// DELETE /api/brands/:id - Delete brand
brandRouter
  .route('/:id')
  .get(
    IdValidation,
    validate,
    getBrand
  )
  .put(
    IdValidation,
    updateBrandValidation,
    validate,
    updateBrand
  )
  .delete(
    IdValidation,
    validate,
    deleteBrand
  );
