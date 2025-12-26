import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  createBrandService,
  getAllBrandsService,
  getBrandByIdService,
  updateBrandService,
  deleteBrandService,
} from '../services/brand.service.js';

import type {
    CreateBrandBody,
    UpdateBrandBody,
    BrandParams
} from '../types/index.js';

// Create a new brand
export const createBrand = asyncHandler(async (req: Request<{}, {}, CreateBrandBody>, res: Response) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    return apiResponse(res, 400, 'error', 'Brand name is required and cannot be empty');
  }

  const brand = await createBrandService(name);

  logger.info('Brand created successfully', {
    brandId: brand._id,
    name: brand.name,
  });

  return apiResponse(res, 201, 'success', 'Brand created successfully', brand);
});

// Get all brands
export const getBrands = asyncHandler(async (req: Request, res: Response) => {
  const brands = await getAllBrandsService();

  return apiResponse(res, 200, 'success', 'Brands retrieved successfully', brands);
});

// Get single brand
export const getBrand = asyncHandler(async (req: Request<BrandParams, {}, {}>, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Brand ID is required');
  }

  const brand = await getBrandByIdService(id);

  return apiResponse(res, 200, 'success', 'Brand retrieved successfully', brand);
});

// Update brand
export const updateBrand = asyncHandler(async (req: Request<BrandParams, {}, UpdateBrandBody>, res: Response) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Brand ID is required');
  }

  if (!name || typeof name !== 'string' || !name.trim()) {
    return apiResponse(res, 400, 'error', 'Brand name is required and cannot be empty');
  }

  const brand = await updateBrandService(id, name);

  logger.info('Brand updated successfully', {
    brandId: id,
    newName: brand.name,
  });

  return apiResponse(res, 200, 'success', 'Brand updated successfully', brand);
});

// Delete brand
export const deleteBrand = asyncHandler(async (req: Request<BrandParams, {}, {}>, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Brand ID is required');
  }

  const brand = await deleteBrandService(id);

  logger.info('Brand deleted successfully', {
    brandId: id,
    name: brand.name,
  });

  return apiResponse(res, 200, 'success', 'Brand deleted successfully');
});