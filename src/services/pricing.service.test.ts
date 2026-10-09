import { describe, it, expect } from 'vitest';
import { computeOrderPricing, computeOrderTotal } from './pricing.service';

describe('computeOrderPricing (customer/agent path)', () => {
  it('applies the v1 rule: $0 tax, free shipping, total = subtotal', () => {
    expect(computeOrderPricing(142.5)).toEqual({ subtotal: 142.5, tax: 0, shipping: 0, total: 142.5 });
  });

  it('rounds to 2 decimal places', () => {
    expect(computeOrderPricing(10.005).total).toBe(10.01);
  });

  it('handles a zero subtotal', () => {
    expect(computeOrderPricing(0)).toEqual({ subtotal: 0, tax: 0, shipping: 0, total: 0 });
  });
});

describe('computeOrderTotal (shared formula / admin override)', () => {
  it('sums subtotal + tax + shipping', () => {
    expect(computeOrderTotal(100, 8.5, 5)).toEqual({ subtotal: 100, tax: 8.5, shipping: 5, total: 113.5 });
  });

  it('rounds every field to 2 decimals', () => {
    const m = computeOrderTotal(10.123, 1.111, 2.049);
    expect(m).toEqual({ subtotal: 10.12, tax: 1.11, shipping: 2.05, total: 13.28 });
  });

  it('is the single source computeOrderPricing delegates to (tax/shipping 0)', () => {
    expect(computeOrderTotal(50, 0, 0)).toEqual(computeOrderPricing(50));
  });
});
