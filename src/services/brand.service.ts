import { inArray, and, eq, ne, sql } from 'drizzle-orm';
import { getDb, pgErrorCode } from '../db/client.js';
import { brands } from '../db/schema/index.js';
import { isId } from '../utils/ids.js';
import { apiNamed, byName } from './shapes.js';

const FOREIGN_KEY_VIOLATION = '23503';
const sameName = (name: string) => sql`lower(${brands.name}) = lower(${name})`;

export const createBrandService = async (name: string) => {
  const trimmedName = name.trim();
  const [existing] = await getDb().select({ id: brands.id }).from(brands).where(sameName(trimmedName)).limit(1);
  if (existing) {
    throw new Error('Brand with this name already exists');
  }
  const [brand] = await getDb().insert(brands).values({ name: trimmedName }).returning();
  return apiNamed(brand!);
};

export const getAllBrandsService = async () => {
  return (await getDb().select().from(brands).orderBy(...byName(brands))).map(apiNamed);
};

export const getBrandByIdService = async (id: string) => {
  if (!isId(id)) {
    throw new Error('Invalid brand ID format');
  }
  const [brand] = await getDb().select().from(brands).where(eq(brands.id, id));
  if (!brand) {
    throw new Error('Brand not found');
  }
  return apiNamed(brand);
};

export const updateBrandService = async (id: string, name: string) => {
  if (!isId(id)) {
    throw new Error('Invalid brand ID format');
  }
  const trimmedName = name.trim();
  const [brand] = await getDb().select({ id: brands.id }).from(brands).where(eq(brands.id, id));
  if (!brand) {
    throw new Error('Brand not found');
  }
  const [other] = await getDb()
    .select({ id: brands.id })
    .from(brands)
    .where(and(sameName(trimmedName), ne(brands.id, id)))
    .limit(1);
  if (other) {
    throw new Error('Another brand with this name already exists');
  }
  const [updated] = await getDb().update(brands).set({ name: trimmedName }).where(eq(brands.id, id)).returning();
  return apiNamed(updated!);
};

export const deleteBrandService = async (id: string) => {
  if (!isId(id)) {
    throw new Error('Invalid brand ID format');
  }
  try {
    const [brand] = await getDb().delete(brands).where(eq(brands.id, id)).returning();
    if (!brand) {
      throw new Error('Brand not found');
    }
    return apiNamed(brand);
  } catch (error) {
    // Spec 023: Postgres keeps products from pointing at a brand that no longer exists.
    if (pgErrorCode(error) === FOREIGN_KEY_VIOLATION) throw new Error('Brand is still used by products. Move or delete them first.');
    throw error;
  }
};

/** The brands with these names, ignoring case; names that match nothing are simply absent. */
export const findBrandsByName = async (names: string[]) => {
  if (names.length === 0) return [];
  const rows = await getDb()
    .select({ id: brands.id, name: brands.name })
    .from(brands)
    .where(inArray(sql`lower(${brands.name})`, names.map((name) => name.toLowerCase())));
  return rows.map((row) => ({ _id: row.id, name: row.name }));
};
