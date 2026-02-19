import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async.handler.js';
import { apiResponse } from '../utils/api.response.js';
import logger from '../utils/logger.js';
import {
  createProductService,
  getAllProductsService,
  getProductByIdService,
  updateProductService,
  deleteProductService,
} from '../services/product.service.js';

import type {
  CreateProductBody,
  UpdateProductBody,
  ProductParams
} from '../types/index.js'

export const createProduct = asyncHandler(async (req: Request<{}, {}, CreateProductBody>, res: Response) => {
  const { name, description, price, stock, category, brand } = req.body;

  if (!name?.trim() || !description?.trim() || !stock) {
    return apiResponse(res, 400, 'error', 'Name, description and stock are required');
  }

  const product = await createProductService(
    name,
    description,
    price,
    stock,
    category,
    brand,
    req.files as Express.Multer.File[]
  );

  logger.info('Product created successfully', {
    productId: product._id,
    name: product.name,
    imagesCount: product.images.length,
  });

  return apiResponse(res, 201, 'success', 'Product created successfully', product);
});

export const getProducts = asyncHandler(async (req: Request, res: Response) => {
  const {
    search,
    category,
    brand,
    minPrice,
    maxPrice,
    sort = 'newest',
    page = '1',
    limit = '20',
  } = req.query;

  const queryParams: Parameters<typeof getAllProductsService>[0] = {
    sort: sort as 'relevance' | 'price_low' | 'price_high' | 'newest' | 'best_selling',
    page: Number(page),
    limit: Number(limit),
  };

  if (search) queryParams.search = String(search);
  if (minPrice) queryParams.minPrice = Number(minPrice);
  if (maxPrice) queryParams.maxPrice = Number(maxPrice);

  if (category) {
    queryParams.category = Array.isArray(category)
      ? category.map(String)
      : [String(category)];
  }

  if (brand) {
    queryParams.brand = Array.isArray(brand)
      ? brand.map(String)
      : [String(brand)];
  }

  const result = await getAllProductsService(queryParams);

  return apiResponse(res, 200, 'success', 'Products retrieved successfully', result);
});

export const getProduct = asyncHandler(async (req: Request<ProductParams, {}, {}>, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Product ID is required');
  }

  const product = await getProductByIdService(id);

  return apiResponse(res, 200, 'success', 'Product retrieved successfully', product);
});

export const updateProduct = asyncHandler(async (req: Request<ProductParams, {}, UpdateProductBody>, res: Response) => {
  const { id } = req.params;
  const { name, description, price, stock, category, brand } = req.body;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Product ID is required');
  }

  if (!name?.trim() || !description?.trim() || !price || !stock || !category?.trim() || !brand?.trimEnd()) {
    return apiResponse(res, 400, 'error', 'Product data is required');
  }

  const product = await updateProductService(
    id,
    { name, description, price, stock, category, brand },
    req.files as Express.Multer.File[]
  );

  logger.info('Product updated successfully', {
    productId: id,
    name: product.name,
  });

  return apiResponse(res, 200, 'success', 'Product updated successfully', product);
});

export const deleteProduct = asyncHandler(async (req: Request<ProductParams,{},{}>, res: Response) => {
  const { id } = req.params;

  if (!id) {
    return apiResponse(res, 400, 'error', 'Product ID is required');
  }

  const product = await deleteProductService(id);

  logger.info('Product permanently deleted', {
    productId: id,
    name: product.name,
    imagesDeleted: product.images.length,
  });

  return apiResponse(res, 200, 'success', 'Product deleted permanently');
});