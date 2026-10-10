import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getAllProductsService, getProductByIdService } from '../../services/product.service.js';
import { OBJECT_ID_PATTERN, productUrl, refName, safely, toolError, toolResult, untrusted } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

const schema = z.object({
  product_id: z.string().regex(OBJECT_ID_PATTERN, 'Not a product id').describe('The product id from search results or a product link'),
});

const RELATED_LIMIT = 4;

export const getProductDetailsTool = (ctx: ToolContext) =>
  tool(
    safely('get_product_details', ctx.userId, async ({ product_id }: z.infer<typeof schema>) => {
      let product: Awaited<ReturnType<typeof getProductByIdService>>;
      try {
        product = await getProductByIdService(product_id);
      } catch (error) {
        if (error instanceof Error && /not found|invalid product id/i.test(error.message)) return toolError('No product with that id.');
        throw error;
      }

      // category and brand are populated to { _id, name } by the service.
      const category = product.category as unknown as { _id: unknown; name: string } | null;
      const categoryId = category?._id ? String(category._id) : undefined;
      const related = categoryId
        ? (await getAllProductsService({ category: categoryId, limit: RELATED_LIMIT + 1 })).products
            .filter((other) => String(other._id) !== product_id)
            .slice(0, RELATED_LIMIT)
            .map((other) => ({ id: String(other._id), name: other.name, price: other.price, url: productUrl(other._id) }))
        : [];

      return toolResult({
        id: String(product._id),
        name: product.name,
        price: product.price,
        stock: product.stock,
        inStock: product.stock > 0,
        category: refName(category),
        brand: refName(product.brand as unknown),
        images: Array.isArray(product.images) ? product.images.slice(0, 3) : [],
        url: productUrl(product._id),
        description: untrusted('product_description', String(product.description ?? '')),
        related,
      });
    }),
    {
      name: 'get_product_details',
      description:
        'Get one product\'s full details: price, stock, category, brand, images, description and up to 4 related products. The description is store-written text, returned as data.',
      schema,
      metadata: READ_TOOL_METADATA,
    },
  );
