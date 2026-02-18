import { Router } from 'express';
import {
  createCategory,
  getCategories,
  getCategory,
  updateCategory,
  deleteCategory,
} from '../controllers/index.js';

import {
  createCategoryValidation,
  updateCategoryValidation,
  IdValidation
} from '../validations/index.js';
import { validate } from '../middlewares/validation.middleware.js';

export const categoryRouter = Router();

// POST /api/categories - Create a new category
categoryRouter.post('/', createCategoryValidation, validate, createCategory);

// GET /api/categories - Get all categories
categoryRouter.get('/', getCategories);

// GET /api/categories/:id - Get category by ID
// PUT /api/categories/:id - Update category
// DELETE /api/categories/:id - Delete category
categoryRouter
  .route('/:id')
  .get(
    IdValidation,
    validate,
    getCategory
  )
  .put(
    IdValidation,
    updateCategoryValidation,
    validate,
    updateCategory
  )
  .delete(
    IdValidation,
    validate,
    deleteCategory
  );
