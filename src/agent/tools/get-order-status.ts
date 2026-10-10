import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getMyOrderById } from '../../services/order.service.js';
import { OBJECT_ID_PATTERN, safely, toolError, toolResult } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

const schema = z.object({
  order_id: z.string().regex(OBJECT_ID_PATTERN, 'Not an order id').describe('The order id, as shown by view_orders or on the My Orders page'),
});

export const getOrderStatusTool = (ctx: ToolContext) =>
  tool(
    safely('get_order_status', ctx.userId, async ({ order_id }: z.infer<typeof schema>) => {
      const order = await getMyOrderById(ctx.userId, order_id);
      // Another customer's order and a missing one get the same answer (security.md §4).
      if (!order) return toolError('No order with that id on your account.');
      return toolResult({
        orderId: String(order._id),
        placedAt: order.createdAt,
        status: order.status,
        paymentStatus: order.paymentStatus,
        ...(order.paidAt ? { paidAt: order.paidAt } : {}),
        ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {}),
        items: order.items.map((item) => ({ name: item.name, quantity: item.quantity, price: item.price })),
        subtotal: order.subtotal,
        shipping: order.shipping,
        tax: order.tax,
        total: order.total,
        shipTo: order.shippingAddress ? { city: order.shippingAddress.city, country: order.shippingAddress.country } : null,
      });
    }),
    {
      name: 'get_order_status',
      description: 'Get one of the customer\'s orders: fulfillment and payment status, items, totals and the destination city and country.',
      schema,
      metadata: READ_TOOL_METADATA,
    },
  );
