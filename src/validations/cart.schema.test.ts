import { describe, it, expect } from 'vitest';
import { addToCartSchema, MAX_CART_ITEM_QUANTITY, updateCartItemSchema } from './cart.schema';

const productId = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';

describe('addToCartSchema', () => {
  it('defaults quantity to 1', () => {
    expect(addToCartSchema.parse({ productId })).toEqual({ productId, quantity: 1 });
  });

  it('accepts quantities from 1 to the maximum', () => {
    expect(addToCartSchema.safeParse({ productId, quantity: 1 }).success).toBe(true);
    expect(addToCartSchema.safeParse({ productId, quantity: MAX_CART_ITEM_QUANTITY }).success).toBe(true);
  });

  it('rejects 0, more than the maximum, fractions and a malformed product id', () => {
    for (const quantity of [0, MAX_CART_ITEM_QUANTITY + 1, 1.5]) {
      expect(addToCartSchema.safeParse({ productId, quantity }).success).toBe(false);
    }
    expect(addToCartSchema.safeParse({ productId: 'not-an-id', quantity: 1 }).success).toBe(false);
    // A MongoDB id from before spec 023 isn't an id any more.
    expect(addToCartSchema.safeParse({ productId: '64b000000000000000000001', quantity: 1 }).success).toBe(false);
  });
});

describe('updateCartItemSchema', () => {
  it('requires a quantity between 1 and the maximum', () => {
    expect(updateCartItemSchema.safeParse({ quantity: 5 }).success).toBe(true);
    expect(updateCartItemSchema.safeParse({}).success).toBe(false);
    expect(updateCartItemSchema.safeParse({ quantity: MAX_CART_ITEM_QUANTITY + 1 }).success).toBe(false);
  });
});
