import { inArray, and, eq, ne, sql } from 'drizzle-orm';
import { getDb, pgErrorCode } from '../db/client.js';
import { categories } from '../db/schema/index.js';
import { isId } from '../utils/ids.js';
import { apiNamed, byName } from './shapes.js';

const FOREIGN_KEY_VIOLATION = '23503';
const sameName = (name: string) => sql`lower(${categories.name}) = lower(${name})`;

export const createCategoryService = async (name: string) => {
  const trimmedName = name.trim();
  const [existing] = await getDb().select({ id: categories.id }).from(categories).where(sameName(trimmedName)).limit(1);
  if (existing) {
    throw new Error('Category with this name already exists');
  }
  const [category] = await getDb().insert(categories).values({ name: trimmedName }).returning();
  return apiNamed(category!);
};

export const getAllCategoriesService = async () => {
  return (await getDb().select().from(categories).orderBy(...byName(categories))).map(apiNamed);
};

export const getCategoryByIdService = async (id: string) => {
  if (!isId(id)) {
    throw new Error('Invalid category ID format');
  }
  const [category] = await getDb().select().from(categories).where(eq(categories.id, id));
  if (!category) {
    throw new Error('Category not found');
  }
  return apiNamed(category);
};

export const updateCategoryService = async (id: string, name: string) => {
  if (!isId(id)) {
    throw new Error('Invalid category ID format');
  }
  const trimmedName = name.trim();
  const [category] = await getDb().select({ id: categories.id }).from(categories).where(eq(categories.id, id));
  if (!category) {
    throw new Error('Category not found');
  }
  const [other] = await getDb()
    .select({ id: categories.id })
    .from(categories)
    .where(and(sameName(trimmedName), ne(categories.id, id)))
    .limit(1);
  if (other) {
    throw new Error('Another category with this name already exists');
  }
  const [updated] = await getDb().update(categories).set({ name: trimmedName }).where(eq(categories.id, id)).returning();
  return apiNamed(updated!);
};

export const deleteCategoryService = async (id: string) => {
  if (!isId(id)) {
    throw new Error('Invalid category ID format');
  }
  try {
    const [category] = await getDb().delete(categories).where(eq(categories.id, id)).returning();
    if (!category) {
      throw new Error('Category not found');
    }
    return apiNamed(category);
  } catch (error) {
    // Spec 023: Postgres keeps products from pointing at a category that no longer exists.
    if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) throw new Error('Category is still used by products. Move or delete them first.');
    throw error;
  }
};

/** The categories with these names, ignoring case; names that match nothing are simply absent. */
export const findCategoriesByName = async (names: string[]) => {
  if (names.length === 0) return [];
  const rows = await getDb()
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(inArray(sql`lower(${categories.name})`, names.map((name) => name.toLowerCase())));
  return rows.map((row) => ({ _id: row.id, name: row.name }));
};
