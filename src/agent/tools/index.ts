// The agent's tools, built per request around the verified user's id (spec 005).
// Names, descriptions and schemas are identical for every user; only the closure differs.

import { getOrderStatusTool } from './get-order-status.js';
import { getProductDetailsTool } from './get-product-details.js';
import { searchProductsTool } from './search-products.js';
import type { ToolContext } from './types.js';
import { viewCartTool } from './view-cart.js';
import { viewOrdersTool } from './view-orders.js';
import { viewProfileTool } from './view-profile.js';

export type { ToolContext } from './types.js';

export const READ_TOOL_NAMES = ['search_products', 'get_product_details', 'view_cart', 'view_orders', 'get_order_status', 'view_profile'] as const;

export function buildToolsForRequest(ctx: ToolContext) {
  return [
    searchProductsTool(ctx),
    getProductDetailsTool(ctx),
    viewCartTool(ctx),
    viewOrdersTool(ctx),
    getOrderStatusTool(ctx),
    viewProfileTool(ctx),
  ];
}
