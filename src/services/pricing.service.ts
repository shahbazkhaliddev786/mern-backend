// Single source of truth for order money (subtotal, tax, shipping, total).
//
// The subtotal is always computed from the cart/items server-side (never
// trusted from the client). The order-total FORMULA and its rounding live here
// so every path that produces order money — customer checkout, the AI agent's
// place_order tool, and admin order edits — agrees (security.md §8).

export interface OrderMoney {
  subtotal: number;
  tax: number;
  shipping: number;
  total: number;
}

const round2 = (n: number): number => Number(Number(n).toFixed(2));

// The one place the order-total formula lives. tax/shipping are explicit here
// because the only caller that sets non-zero values is the trusted admin path.
export const computeOrderTotal = (
  subtotal: number,
  tax: number,
  shipping: number
): OrderMoney => {
  const s = round2(subtotal);
  const t = round2(tax);
  const sh = round2(shipping);
  return { subtotal: s, tax: t, shipping: sh, total: round2(s + t + sh) };
};

// Customer / agent checkout path. v1 store rule: $0 tax, free shipping —
// matches the store's current behavior. Change the rule HERE when the store
// introduces real tax/shipping.
export const computeOrderPricing = (subtotal: number): OrderMoney =>
  computeOrderTotal(subtotal, 0, 0);
