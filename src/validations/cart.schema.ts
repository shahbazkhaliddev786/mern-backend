// Cart input schemas (zod), shared by the cart routes and the agent's
// add_to_cart / update_cart_item tools so both enforce the same bounds
// (architecture.md §4). Stock is checked separately, in the cart services.

import { z } from 'zod';

export const MAX_CART_ITEM_QUANTITY = 99;

const productId = z.string().regex(/^[a-f\d]{24}$/i, 'Valid product ID is required');

const quantity = z.coerce
  .number()
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(MAX_CART_ITEM_QUANTITY, `Quantity can be at most ${MAX_CART_ITEM_QUANTITY}`);

export const addToCartSchema = z.object({
  productId,
  quantity: quantity.default(1),
});

// Over HTTP, items are removed with DELETE, so quantity starts at 1 here. (The
// agent's update_cart_item treats 0 as "remove" — architecture.md §4.)
export const updateCartItemSchema = z.object({ quantity });
