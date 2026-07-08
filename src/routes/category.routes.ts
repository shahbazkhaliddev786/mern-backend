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
import { authMiddleware } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/admin.js';

export const categoryRouter = Router();

// POST /api/categories - Create a new category (admin only)
categoryRouter.post('/', authMiddleware, requireRole(['admin']), createCategoryValidation, validate, createCategory);

// GET /api/categories - Get all categories
categoryRouter.get('/', getCategories);

// GET /api/categories/:id - Get category by ID
// PUT /api/categories/:id - Update category (admin only)
// DELETE /api/categories/:id - Delete category (admin only)
categoryRouter
  .route('/:id')
  .get(
    IdValidation,
    validate,
    getCategory
  )
  .put(
    authMiddleware,
    requireRole(['admin']),
    IdValidation,
    updateCategoryValidation,
    validate,
    updateCategory
  )
  .delete(
    authMiddleware,
    requireRole(['admin']),
    IdValidation,
    validate,
    deleteCategory
  );
