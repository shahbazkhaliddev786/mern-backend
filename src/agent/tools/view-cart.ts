import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getCart } from '../../services/cart.service.js';
import { computeOrderPricing } from '../../services/pricing.service.js';
import { safely, toolResult } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

export const viewCartTool = (ctx: ToolContext) =>
  tool(
    safely('view_cart', ctx.userId, async () => {
      const cart = await getCart(ctx.userId);
      const items = (cart.items as { product?: Record<string, unknown> | null; quantity: number }[])
        .filter((item) => item.product && typeof item.product === 'object')
        .map((item) => {
          const product = item.product as Record<string, unknown>;
          const unitPrice = Number(product.price);
          return {
            productId: String(product._id),
            name: product.name,
            unitPrice,
            quantity: item.quantity,
            lineTotal: Number((unitPrice * item.quantity).toFixed(2)),
            stock: product.stock,
          };
        });
      const { subtotal, shipping, tax, total } = computeOrderPricing(cart.subtotal);
      return toolResult({ items, itemsCount: cart.itemsCount, subtotal, shipping, tax, total });
    }),
    {
      name: 'view_cart',
      description: 'Show the customer\'s cart: items, quantities, line totals, subtotal, shipping, tax and total.',
      schema: z.object({}),
      metadata: READ_TOOL_METADATA,
    },
  );
