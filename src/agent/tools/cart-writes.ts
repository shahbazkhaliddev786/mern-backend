// Cart write tools (spec 008). Single-item edits run straight away — reversible, no money
// moves (security.md §6); clearing the whole cart is bulk, so it waits for the customer's "yes".

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { addToCart, clearCart, getCart, updateCartItem } from '../../services/cart.service.js';
import { computeOrderPricing } from '../../services/pricing.service.js';
import { MAX_CART_ITEM_QUANTITY } from '../../validations/cart.schema.js';
import { cartSummary, OBJECT_ID_PATTERN, safely, toolError, toolResult } from './helpers.js';
import { CONFIRMED_WRITE_TOOL_METADATA, WRITE_TOOL_METADATA, type ToolContext } from './types.js';

const productId = z.string().regex(OBJECT_ID_PATTERN, 'Not a product id').describe('The product id from search results or product details');

// The cart service's known failures, as sentences the customer can act on.
const CART_ERRORS: [RegExp, string][] = [
  [/not enough stock|insufficient stock/i, 'There isn\'t enough stock for that quantity.'],
  [/product not found/i, 'That product no longer exists.'],
  [/item not in cart|cart not found/i, 'That product isn\'t in the cart.'],
];

async function cartWrite(write: () => Promise<{ items: unknown[]; itemsCount: number; subtotal: number }>) {
  try {
    return toolResult(cartSummary(await write()));
  } catch (error) {
    const known = error instanceof Error && CART_ERRORS.find(([pattern]) => pattern.test(error.message));
    if (known) return toolError(known[1]);
    throw error;
  }
}

const addSchema = z.object({
  product_id: productId,
  quantity: z.number().int().min(1).max(MAX_CART_ITEM_QUANTITY).optional().describe('How many to add; defaults to 1'),
});

export const addToCartTool = (ctx: ToolContext) =>
  tool(
    safely('add_to_cart', ctx.userId, ({ product_id, quantity }: z.infer<typeof addSchema>) =>
      cartWrite(() => addToCart(ctx.userId, product_id, quantity ?? 1)),
    ),
    {
      name: 'add_to_cart',
      description: 'Add a product to the customer\'s cart (adds to the quantity already there). Returns the updated cart.',
      schema: addSchema,
      metadata: WRITE_TOOL_METADATA,
    },
  );

const updateSchema = z.object({
  product_id: productId,
  quantity: z.number().int().min(0).max(MAX_CART_ITEM_QUANTITY).describe('The new quantity; 0 removes the item'),
});

export const updateCartItemTool = (ctx: ToolContext) =>
  tool(
    safely('update_cart_item', ctx.userId, ({ product_id, quantity }: z.infer<typeof updateSchema>) =>
      cartWrite(() => updateCartItem(ctx.userId, product_id, quantity)),
    ),
    {
      name: 'update_cart_item',
      description: 'Set the quantity of a product already in the cart; quantity 0 removes it. Returns the updated cart.',
      schema: updateSchema,
      metadata: WRITE_TOOL_METADATA,
    },
  );

export const clearCartTool = (ctx: ToolContext) =>
  tool(
    safely('clear_cart', ctx.userId, () => cartWrite(() => clearCart(ctx.userId))),
    {
      name: 'clear_cart',
      description:
        'Remove every item from the customer\'s cart. The app asks the customer to confirm before it runs; call it when they ask to empty the cart.',
      schema: z.object({}),
      metadata: CONFIRMED_WRITE_TOOL_METADATA,
    },
  );

/** What the customer is asked to confirm for clear_cart — read-only, computed from the cart. */
export async function summarizeClearCart(ctx: ToolContext): Promise<string> {
  const cart = await getCart(ctx.userId);
  if (!cart.itemsCount) return 'Your cart is already empty. Clear it anyway?';
  const { total } = computeOrderPricing(cart.subtotal);
  const items = cart.itemsCount === 1 ? '1 item' : `${cart.itemsCount} items`;
  return `Remove all ${items} ($${total.toFixed(2)}) from your cart?`;
}
