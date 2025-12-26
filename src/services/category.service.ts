import { Types } from 'mongoose';
import { Category } from '../models/index.js';

export const createCategoryService = async (name: string) => {
  const trimmedName = name.trim();

  const existingCategory = await Category.findOne({
    name: { $regex: `^${trimmedName}$`, $options: 'i' },
  });

  if (existingCategory) {
    throw new Error('Category with this name already exists');
  }

  const category = await Category.create({ name: trimmedName });

  return category;
};

export const getAllCategoriesService = async () => {
  return await Category.find().sort({ name: 1 }).select('-__v');
};

export const getCategoryByIdService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid category ID format');
  }

  const category = await Category.findById(id).select('-__v');
  if (!category) {
    throw new Error('Category not found');
  }

  return category;
};

export const updateCategoryService = async (id: string, name: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid category ID format');
  }

  const trimmedName = name.trim();

  const category = await Category.findById(id);
  if (!category) {
    throw new Error('Category not found');
  }

  const existingCategory = await Category.findOne({
    name: { $regex: `^${trimmedName}$`, $options: 'i' },
    _id: { $ne: new Types.ObjectId(id) },
  });

  if (existingCategory) {
    throw new Error('Another category with this name already exists');
  }

  category.name = trimmedName;
  await category.save();

  return category;
};

export const deleteCategoryService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid category ID format');
  }

  const category = await Category.findByIdAndDelete(id);
  if (!category) {
    throw new Error('Category not found');
  }

  return category;
};