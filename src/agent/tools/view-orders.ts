import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getMyOrders } from '../../services/order.service.js';
import { safely, toolResult } from './helpers.js';
import { READ_TOOL_METADATA, type ToolContext } from './types.js';

const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] as const;
const LIST_LIMIT = 10;

const schema = z.object({
  status: z.enum(ORDER_STATUSES).optional().describe('Only orders with this fulfillment status'),
});

export const viewOrdersTool = (ctx: ToolContext) =>
  tool(
    safely('view_orders', ctx.userId, async ({ status }: z.infer<typeof schema>) => {
      const orders = (await getMyOrders(ctx.userId)).filter((order) => !status || order.status === status);
      return toolResult({
        orders: orders.slice(0, LIST_LIMIT).map((order) => ({
          orderId: String(order._id),
          placedAt: order.createdAt,
          status: order.status,
          paymentStatus: order.paymentStatus,
          itemsCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
          total: order.total,
          items: order.items.map((item) => item.name),
        })),
        totalMatching: orders.length,
      });
    }),
    {
      name: 'view_orders',
      description: 'List the customer\'s orders, newest first (up to 10), optionally filtered by fulfillment status. Use get_order_status for one order\'s details.',
      schema,
      metadata: READ_TOOL_METADATA,
    },
  );
