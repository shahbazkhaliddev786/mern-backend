import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getCart } from '../../services/cart.service.js';
import { cartSummary, safely, toolResult } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

export const viewCartTool = (ctx: ToolContext) =>
  tool(
    safely('view_cart', ctx.userId, async () => toolResult(cartSummary(await getCart(ctx.userId)))),
    {
      name: 'view_cart',
      description: 'Show the customer\'s cart: items, quantities, line totals, subtotal, shipping, tax and total.',
      schema: z.object({}),
      metadata: READ_TOOL_METADATA,
    },
  );
