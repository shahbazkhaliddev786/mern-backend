import { and, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users } from '../db/schema/index.js';
import cloudinary from '../utils/cloudinary.js';
import { isId } from '../utils/ids.js';
import { compact } from './shapes.js';

// The admin panel's view of a user: never the password, tokens or pending-email secrets.
const adminUser = (user: typeof users.$inferSelect) =>
  compact({
    id: user.id,
    name: user.name,
    email: user.email,
    profile: user.profile,
    role: user.role,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
  });

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
  const conditions: SQL[] = [];

  if (role) {
    conditions.push(sql`${users.role} = ${role}`);
  }

  const term = search?.trim();
  if (term) {
    // A case-insensitive pattern on name or email, as the Mongo regex was.
    conditions.push(or(sql`${users.name} ~* ${term}`, sql`${users.email} ~* ${term}`)!);
  }
  const where = conditions.length ? and(...conditions) : undefined;

  const [counted] = await getDb().select({ total: count() }).from(users).where(where);
  const totalItems = counted?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / limit));
  const skip = (page - 1) * limit;

  const rows = await getDb().select().from(users).where(where).orderBy(desc(users.createdAt), desc(users.id)).limit(limit).offset(skip);

  return {
    users: rows.map(adminUser),
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

  const [user] = isId(targetUserId) ? await getDb().update(users).set({ role }).where(eq(users.id, targetUserId)).returning() : [];
  if (!user) throw new Error('User not found');

  return adminUser(user);
};

export const adminDeleteUserService = async (requestingAdminId: string, targetUserId: string) => {
  if (requestingAdminId === targetUserId) {
    throw new Error('You cannot delete your own account from this panel');
  }

  const [user] = isId(targetUserId) ? await getDb().select().from(users).where(eq(users.id, targetUserId)) : [];
  if (!user) throw new Error('User not found');

  if (user.profile) {
    const publicId = `profiles/${user.id}`;
    await cloudinary.uploader.destroy(publicId).catch(() => {});
  }

  // Their cart, pending checkouts and uploads go with them; their orders stay, without a user.
  await getDb().delete(users).where(eq(users.id, targetUserId));

  return { message: 'User deleted successfully' };
};
