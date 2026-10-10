// The agent's tools, built per request around the verified user's id (specs 005, 008).
// Names, descriptions and schemas are identical for every user; only the closure differs.

import { addToCartTool, clearCartTool, summarizeClearCart, updateCartItemTool } from './cart-writes.js';
import { placeOrderTool, summarizePlaceOrder } from './place-order.js';
import { submitSupportRequestTool, summarizeSupportRequest, summarizeUpdateProfile, updateProfileTool } from './account-writes.js';
import { getOrderStatusTool } from './get-order-status.js';
import { getProductDetailsTool } from './get-product-details.js';
import { searchProductsTool } from './search-products.js';
import type { ToolContext } from './types.js';
import { viewCartTool } from './view-cart.js';
import { viewOrdersTool } from './view-orders.js';
import { viewProfileTool } from './view-profile.js';

export type { ToolContext } from './types.js';

export const READ_TOOL_NAMES = ['search_products', 'get_product_details', 'view_cart', 'view_orders', 'get_order_status', 'view_profile'] as const;
export const WRITE_TOOL_NAMES = ['add_to_cart', 'update_cart_item', 'clear_cart', 'place_order', 'update_profile', 'submit_support_request'] as const;
export const AGENT_TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;

export function buildToolsForRequest(ctx: ToolContext) {
  return [
    searchProductsTool(ctx),
    getProductDetailsTool(ctx),
    viewCartTool(ctx),
    viewOrdersTool(ctx),
    getOrderStatusTool(ctx),
    viewProfileTool(ctx),
    addToCartTool(ctx),
    updateCartItemTool(ctx),
    clearCartTool(ctx),
    placeOrderTool(ctx),
    updateProfileTool(ctx),
    submitSupportRequestTool(ctx),
  ];
}

// The sentence the customer confirms, per confirm-required tool. Read-only (spec 002: nothing
// with a side effect before interrupt()).
const CONFIRM_SUMMARIES: Record<string, (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>> = {
  clear_cart: (ctx) => summarizeClearCart(ctx),
  place_order: (ctx, args) => summarizePlaceOrder(ctx, args),
  update_profile: (ctx, args) => summarizeUpdateProfile(ctx, args),
  submit_support_request: (ctx, args) => summarizeSupportRequest(ctx, args),
};

export async function summarizeConfirmation(ctx: ToolContext, call: { name: string; args: Record<string, unknown> }): Promise<string> {
  const summarize = CONFIRM_SUMMARIES[call.name];
  return summarize ? summarize(ctx, call.args) : `Go ahead with ${call.name.replace(/_/g, ' ')}?`;
}
