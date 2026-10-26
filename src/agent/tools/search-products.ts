import { tool } from '@langchain/core/tools';
import { Brand, Category } from '../../models/index.js';
import { getAllProductsService } from '../../services/product.service.js';
import { productQuerySchema, SORT_TO_SERVICE, type ProductQuery } from '../../validations/product-query.schema.js';
import { escapeRegex, productUrl, refName, safely, toolResult } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

export const SEARCH_PAGE_SIZE = 8;

// Case-insensitive exact name match; names that match nothing are reported, never guessed.
async function resolveNames(model: typeof Brand | typeof Category, names: string[] | undefined) {
  if (!names?.length) return { ids: undefined, unknown: [] as string[] };
  const docs = await model
    .find({ name: { $in: names.map((name) => new RegExp(`^${escapeRegex(name)}$`, 'i')) } })
    .select('name')
    .lean<{ _id: unknown; name: string }[]>();
  const found = new Set(docs.map((doc) => doc.name.toLowerCase()));
  return { ids: docs.map((doc) => String(doc._id)), unknown: names.filter((name) => !found.has(name.toLowerCase())) };
}

export const searchProductsTool = (ctx: ToolContext) =>
  tool(
    safely('search_products', ctx.userId, async (args: ProductQuery) => {
      const categories = await resolveNames(Category, args.categories);
      const brands = await resolveNames(Brand, args.brands);
      // Every requested category (or brand) was unknown: say so rather than searching everything.
      if ((args.categories?.length && !categories.ids?.length) || (args.brands?.length && !brands.ids?.length)) {
        return toolResult({ results: [], page: 1, totalPages: 0, totalItems: 0, unknownCategories: categories.unknown, unknownBrands: brands.unknown });
      }

      const { products, pagination } = await getAllProductsService({
        ...(args.query ? { search: escapeRegex(args.query) } : {}),
        ...(categories.ids ? { category: categories.ids } : {}),
        ...(brands.ids ? { brand: brands.ids } : {}),
        ...(args.min_price !== undefined ? { minPrice: args.min_price } : {}),
        ...(args.max_price !== undefined ? { maxPrice: args.max_price } : {}),
        ...(args.in_stock ? { inStock: true } : {}),
        sort: SORT_TO_SERVICE[args.sort ?? 'newest'],
        page: args.page ?? 1,
        limit: SEARCH_PAGE_SIZE,
      });

      return toolResult({
        results: products.map((product) => ({
          id: String(product._id),
          name: product.name,
          price: product.price,
          inStock: product.stock > 0,
          stock: product.stock,
          // Populated to { _id, name } by the service.
          category: refName(product.category as unknown),
          brand: refName(product.brand as unknown),
          url: productUrl(product._id),
        })),
        page: pagination.currentPage,
        totalPages: pagination.totalPages,
        totalItems: pagination.totalItems,
        ...(categories.unknown.length ? { unknownCategories: categories.unknown } : {}),
        ...(brands.unknown.length ? { unknownBrands: brands.unknown } : {}),
      });
    }),
    {
      name: 'search_products',
      description:
        'Search the Aljo Store catalog by keywords, category and brand names, price range and stock. Returns up to 8 products per page with price, stock and a link. Use get_product_details for a product\'s description.',
      schema: productQuerySchema,
      metadata: READ_TOOL_METADATA,
    },
  );
