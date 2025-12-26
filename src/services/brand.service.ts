import { Types } from 'mongoose';
import { Brand } from '../models/index.js';

export const createBrandService = async (name: string) => {
  const trimmedName = name.trim();

  const existingBrand = await Brand.findOne({
    name: { $regex: `^${trimmedName}$`, $options: 'i' },
  });

  if (existingBrand) {
    throw new Error('Brand with this name already exists');
  }

  const brand = await Brand.create({ name: trimmedName });

  return brand;
};

export const getAllBrandsService = async () => {
  return await Brand.find().sort({ name: 1 }).select('-__v');
};

export const getBrandByIdService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid brand ID format');
  }

  const brand = await Brand.findById(id).select('-__v');
  if (!brand) {
    throw new Error('Brand not found');
  }

  return brand;
};

export const updateBrandService = async (id: string, name: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid brand ID format');
  }

  const trimmedName = name.trim();

  const brand = await Brand.findById(id);
  if (!brand) {
    throw new Error('Brand not found');
  }

  const existingBrand = await Brand.findOne({
    name: { $regex: `^${trimmedName}$`, $options: 'i' },
    _id: { $ne: new Types.ObjectId(id) },
  });

  if (existingBrand) {
    throw new Error('Another brand with this name already exists');
  }

  brand.name = trimmedName;
  await brand.save();

  return brand;
};

export const deleteBrandService = async (id: string) => {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error('Invalid brand ID format');
  }

  const brand = await Brand.findByIdAndDelete(id);
  if (!brand) {
    throw new Error('Brand not found');
  }

  return brand;
};