import { count, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { orders, products, users } from '../db/schema/index.js';

const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function computeChangePct(current: number, previous: number): number | null {
  if (previous === 0) {
    return current > 0 ? null : 0;
  }
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

const sumOf = (filter: ReturnType<typeof sql>) => sql<number>`coalesce(sum(${orders.total}) filter (where ${filter}), 0)`.mapWith(Number);
const countOf = (filter: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${filter})`.mapWith(Number);

export const getDashboardSummaryService = async () => {
  const now = new Date();
  const startCurrentPeriod = new Date(now.getTime() - 30 * DAY_MS);
  const startPreviousPeriod = new Date(now.getTime() - 60 * DAY_MS);

  const chartStart = startOfUtcDay(new Date(now.getTime() - 13 * DAY_MS));

  const paid = sql`${orders.status} <> 'cancelled'`;
  const orderCurrent = sql`${orders.createdAt} >= ${startCurrentPeriod}`;
  const orderPrevious = sql`${orders.createdAt} >= ${startPreviousPeriod} and ${orders.createdAt} < ${startCurrentPeriod}`;
  const day = sql<string>`to_char(${orders.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const db = getDb();
  const [[orderTotals], [userTotals], [productTotals], ordersByStatusRows, revenueSeriesRows] = await Promise.all([
    db
      .select({
        revenue: sumOf(paid),
        orders: count(),
        revenueCurrent: sumOf(sql`${paid} and ${orderCurrent}`),
        revenuePrevious: sumOf(sql`${paid} and ${orderPrevious}`),
        ordersCurrent: countOf(orderCurrent),
        ordersPrevious: countOf(orderPrevious),
      })
      .from(orders),
    db
      .select({
        users: count(),
        current: countOf(sql`${users.createdAt} >= ${startCurrentPeriod}`),
        previous: countOf(sql`${users.createdAt} >= ${startPreviousPeriod} and ${users.createdAt} < ${startCurrentPeriod}`),
      })
      .from(users),
    db.select({ products: count() }).from(products),
    db.select({ status: orders.status, count: count() }).from(orders).groupBy(orders.status),
    db
      .select({ date: day, sum: sql<number>`sum(${orders.total})`.mapWith(Number) })
      .from(orders)
      .where(sql`${paid} and ${orders.createdAt} >= ${chartStart}`)
      .groupBy(day),
  ]);

  const ordersByStatus: Record<string, number> = Object.fromEntries(
    ORDER_STATUSES.map((status) => [status, 0])
  );
  for (const entry of ordersByStatusRows) {
    if (entry.status in ordersByStatus) {
      ordersByStatus[entry.status] = entry.count;
    }
  }

  const revenueByDate = new Map<string, number>(revenueSeriesRows.map((entry) => [entry.date, entry.sum]));

  const revenueSeries = Array.from({ length: 14 }, (_, i) => {
    const date = startOfUtcDay(new Date(chartStart.getTime() + i * DAY_MS));
    const key = formatUtcDate(date);
    return { date: key, revenue: Number((revenueByDate.get(key) ?? 0).toFixed(2)) };
  });

  const revenueCurrent = orderTotals?.revenueCurrent ?? 0;
  const revenuePrevious = orderTotals?.revenuePrevious ?? 0;
  const ordersCurrent = orderTotals?.ordersCurrent ?? 0;
  const ordersPrevious = orderTotals?.ordersPrevious ?? 0;
  const usersCurrent = userTotals?.current ?? 0;
  const usersPrevious = userTotals?.previous ?? 0;

  return {
    totals: {
      revenue: Number((orderTotals?.revenue ?? 0).toFixed(2)),
      orders: orderTotals?.orders ?? 0,
      users: userTotals?.users ?? 0,
      products: productTotals?.products ?? 0,
    },
    trends: {
      revenue: {
        current: Number(revenueCurrent.toFixed(2)),
        previous: Number(revenuePrevious.toFixed(2)),
        changePct: computeChangePct(revenueCurrent, revenuePrevious),
      },
      orders: {
        current: ordersCurrent,
        previous: ordersPrevious,
        changePct: computeChangePct(ordersCurrent, ordersPrevious),
      },
      users: {
        current: usersCurrent,
        previous: usersPrevious,
        changePct: computeChangePct(usersCurrent, usersPrevious),
      },
    },
    ordersByStatus,
    revenueSeries,
  };
};
