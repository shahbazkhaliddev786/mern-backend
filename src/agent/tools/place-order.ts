// place_order (spec 010): starts a Stripe checkout for the customer's cart. Confirm-required;
// the customer sees the items, the server total and the full address before anything happens.
// Payment happens on Stripe's page; the order itself is created by the webhook after payment.

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getCart } from '../../services/cart.service.js';
import { createOrReuseCheckoutSession, getMyOrders } from '../../services/order.service.js';
import { computeOrderPricing } from '../../services/pricing.service.js';
import type { IShippingAddress } from '../../models/order.model.js';
import logger from '../../utils/logger.js';
import { shippingSchema, type ShippingAddress } from '../../validations/shipping.schema.js';
import { safely, toolError, toolResult } from './helpers.js';
import { CONFIRMED_WRITE_TOOL_METADATA, type ToolContext } from './types.js';

const schema = z.object({
  shipping_address: shippingSchema
    .optional()
    .describe("Only when the customer gives a new address. Omit to use the address of the customer's last order."),
});
type Args = z.infer<typeof schema>;

const NO_ADDRESS = 'I need a shipping address: full name, street address, city, postal code and country.';
const SUMMARY_ITEM_LIMIT = 5;

/** The address the order will use: the one given, else the last order's (only if still valid). */
async function resolveAddress(ctx: ToolContext, args: Args): Promise<ShippingAddress | null> {
  if (args.shipping_address) return args.shipping_address;
  const [last] = await getMyOrders(ctx.userId);
  const parsed = shippingSchema.safeParse(last?.shippingAddress ?? {});
  return parsed.success ? parsed.data : null;
}

// The order model leaves unset optional fields out rather than holding undefined.
const toShippingAddress = (a: ShippingAddress): IShippingAddress =>
  Object.fromEntries(Object.entries(a).filter(([, value]) => value !== undefined && value !== '')) as unknown as IShippingAddress;

export const formatAddress = (a: ShippingAddress) =>
  [a.fullName, a.address, a.apartment, a.city, [a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');

export const placeOrderTool = (ctx: ToolContext) =>
  tool(
    safely('place_order', ctx.userId, async (args: Args) => {
      const address = await resolveAddress(ctx, args);
      if (!address) return toolError(NO_ADDRESS);
      let checkout: Awaited<ReturnType<typeof createOrReuseCheckoutSession>>;
      try {
        checkout = await createOrReuseCheckoutSession(ctx.userId, toShippingAddress(address));
      } catch (error) {
        if (error instanceof Error && /cart is empty/i.test(error.message)) return toolError('Your cart is empty.');
        throw error;
      }
      logger.info('ORDER_CHECKOUT', {
        userId: ctx.userId,
        pendingCheckoutId: checkout.pendingCheckoutId,
        reused: checkout.reused,
        total: checkout.total,
      });
      return toolResult({ checkoutUrl: checkout.url, itemsCount: checkout.itemsCount, total: checkout.total, reused: checkout.reused });
    }),
    {
      name: 'place_order',
      description:
        "Start checkout for everything in the customer's cart. The app shows the customer the items, total and shipping address to confirm first. Returns a Stripe link where they pay by card; the order is placed once they pay there.",
      schema,
      metadata: CONFIRMED_WRITE_TOOL_METADATA,
    },
  );

/** What the customer confirms for place_order: items, server total and the address that will be used. Read-only. */
export async function summarizePlaceOrder(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const cart = await getCart(ctx.userId);
  if (!cart.itemsCount) return "Your cart is empty, so there's nothing to order. Cancel and add something first.";
  const address = await resolveAddress(ctx, schema.safeParse(args).success ? (args as Args) : {});
  if (!address) return "There's no shipping address to use yet. Cancel and tell me where to ship.";

  const { total } = computeOrderPricing(cart.subtotal);
  const lines = (cart.items as { product?: { name?: string } | null; quantity: number }[])
    .filter((item) => item.product?.name)
    .map((item) => `${item.product!.name} ×${item.quantity}`);
  const shown = lines.slice(0, SUMMARY_ITEM_LIMIT).join(', ') + (lines.length > SUMMARY_ITEM_LIMIT ? `, and ${lines.length - SUMMARY_ITEM_LIMIT} more` : '');
  const items = cart.itemsCount === 1 ? '1 item' : `${cart.itemsCount} items`;
  return `Place an order for ${items} ($${total.toFixed(2)}) — ${shown} — shipping to ${formatAddress(address)}? You'll pay by card on Stripe's secure page.`;
}
