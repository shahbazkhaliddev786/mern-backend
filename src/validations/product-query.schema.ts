import { z } from 'zod';

// A product search as the agent's search_products tool takes it (spec 005). Categories and
// brands are names, not ids: the model only ever sees names.
export const productQuerySchema = z.object({
  query: z.string().trim().min(1).max(100).optional().describe('Keywords to match in product names and descriptions'),
  categories: z.array(z.string().trim().min(1).max(60)).max(5).optional().describe('Category names, e.g. "Shoes"'),
  brands: z.array(z.string().trim().min(1).max(60)).max(5).optional().describe('Brand names'),
  min_price: z.number().min(0).optional().describe('Minimum price in USD'),
  max_price: z.number().min(0).optional().describe('Maximum price in USD'),
  in_stock: z.boolean().optional().describe('Only products currently in stock'),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).optional().describe('Result order; defaults to newest'),
  page: z.number().int().min(1).max(20).optional().describe('Results page, 8 per page; defaults to 1'),
});

export type ProductQuery = z.infer<typeof productQuerySchema>;

// The catalog service's names for the same sort orders.
export const SORT_TO_SERVICE = { newest: 'newest', price_asc: 'price_low', price_desc: 'price_high' } as const;
