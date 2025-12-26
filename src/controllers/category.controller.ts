import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  createCategoryService,
  getAllCategoriesService,
  getCategoryByIdService,
  updateCategoryService,
  deleteCategoryService,
} from '../services/category.service.js';
import type {
    CreateCategoryBody,
    UpdateCategoryBody,
    CategoryParams
} from '../types/index.js';

// Create a new category
export const createCategory = asyncHandler(async (req: Request<{}, {}, CreateCategoryBody>, res: Response) => {
  const { name } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    return apiResponse(res, 400, 'error', 'Category name is required and cannot be empty');
  }

  const category = await createCategoryService(name);

  logger.info('Category created successfully', {
    categoryId: category._id,
    name: category.name,
  });

  return apiResponse(res, 201, 'success', 'Category created successfully', category);
});

// Get all categories
export const getCategories = asyncHandler(async (req: Request, res: Response) => {
  const categories = await getAllCategoriesService();

  return apiResponse(res, 200, 'success', 'Categories retrieved successfully', categories);
});

// Get single category
export const getCategory = asyncHandler(async (req: Request<CategoryParams,{},{}>, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Category ID is required');
  }

  const category = await getCategoryByIdService(id);

  return apiResponse(res, 200, 'success', 'Category retrieved successfully', category);
});

// Update category
export const updateCategory = asyncHandler(async (req: Request<CategoryParams,{}, UpdateCategoryBody>, res: Response) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Category ID is required');
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    return apiResponse(res, 400, 'error', 'Category name is required and cannot be empty');
  }

  const category = await updateCategoryService(id, name);

  logger.info('Category updated successfully', {
    categoryId: id,
    newName: category.name,
  });

  return apiResponse(res, 200, 'success', 'Category updated successfully', category);
});

// Delete category
export const deleteCategory = asyncHandler(async (req: Request<CategoryParams, {}, {}>, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Category ID is required');
  }

  const category = await deleteCategoryService(id);

  logger.info('Category deleted successfully', {
    categoryId: id,
    name: category.name,
  });

  return apiResponse(res, 200, 'success', 'Category deleted successfully');
});