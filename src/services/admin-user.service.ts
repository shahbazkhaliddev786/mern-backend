import { User } from '../models/index.js';
import cloudinary from '../utils/cloudinary.js';

const SAFE_FIELDS = '-password -refreshTokens';

export const getAllUsersService = async ({
  search,
  role,
  page = 1,
  limit = 20,
}: {
  search?: string;
  role?: string;
  page?: number;
  limit?: number;
} = {}) => {
  const query: any = {};

  if (role) {
    query.role = role;
  }

  if (search && search.trim()) {
    const regex = new RegExp(search.trim(), 'i');
    query.$or = [{ name: regex }, { email: regex }];
  }

  const totalItems = await User.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const skip = (page - 1) * limit;

  const users = await User.find(query)
    .select(SAFE_FIELDS)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  return {
    users: users.map((user: any) => ({
      id: user._id,
      name: user.name,
      email: user.email,
      profile: user.profile,
      role: user.role,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
    })),
    pagination: {
      currentPage: page,
      totalPages,
      totalItems,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
};

export const adminUpdateUserRoleService = async (
  requestingAdminId: string,
  targetUserId: string,
  role: 'user' | 'admin'
) => {
  if (requestingAdminId === targetUserId) {
    throw new Error('You cannot change your own role from this panel');
  }

  const user = await User.findById(targetUserId);
  if (!user) throw new Error('User not found');

  user.role = role;
  await user.save();

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    profile: user.profile,
    role: user.role,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
  };
};

export const adminDeleteUserService = async (requestingAdminId: string, targetUserId: string) => {
  if (requestingAdminId === targetUserId) {
    throw new Error('You cannot delete your own account from this panel');
  }

  const user = await User.findById(targetUserId);
  if (!user) throw new Error('User not found');

  if (user.profile) {
    const publicId = `profiles/${user._id}`;
    await cloudinary.uploader.destroy(publicId).catch(() => {});
  }

  await User.deleteOne({ _id: targetUserId });

  return { message: 'User deleted successfully' };
};
