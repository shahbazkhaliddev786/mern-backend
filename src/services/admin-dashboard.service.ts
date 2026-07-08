import { Order, Product, User } from '../models/index.js';

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

export const getDashboardSummaryService = async () => {
  const now = new Date();
  const startCurrentPeriod = new Date(now.getTime() - 30 * DAY_MS);
  const startPreviousPeriod = new Date(now.getTime() - 60 * DAY_MS);

  const chartStart = startOfUtcDay(new Date(now.getTime() - 13 * DAY_MS));

  const [
    revenueTotalAgg,
    ordersTotal,
    usersTotal,
    productsTotal,
    revenueCurrentAgg,
    revenuePreviousAgg,
    ordersCurrent,
    ordersPrevious,
    usersCurrent,
    usersPrevious,
    ordersByStatusAgg,
    revenueSeriesAgg,
  ] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: null, sum: { $sum: '$total' } } },
    ]),
    Order.countDocuments({}),
    User.countDocuments({}),
    Product.countDocuments({}),
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: startCurrentPeriod } } },
      { $group: { _id: null, sum: { $sum: '$total' } } },
    ]),
    Order.aggregate([
      {
        $match: {
          status: { $ne: 'cancelled' },
          createdAt: { $gte: startPreviousPeriod, $lt: startCurrentPeriod },
        },
      },
      { $group: { _id: null, sum: { $sum: '$total' } } },
    ]),
    Order.countDocuments({ createdAt: { $gte: startCurrentPeriod } }),
    Order.countDocuments({ createdAt: { $gte: startPreviousPeriod, $lt: startCurrentPeriod } }),
    User.countDocuments({ createdAt: { $gte: startCurrentPeriod } }),
    User.countDocuments({ createdAt: { $gte: startPreviousPeriod, $lt: startCurrentPeriod } }),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' }, createdAt: { $gte: chartStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          sum: { $sum: '$total' },
        },
      },
    ]),
  ]);

  const ordersByStatus: Record<string, number> = Object.fromEntries(
    ORDER_STATUSES.map((status) => [status, 0])
  );
  for (const entry of ordersByStatusAgg as { _id: string; count: number }[]) {
    if (entry._id && entry._id in ordersByStatus) {
      ordersByStatus[entry._id] = entry.count;
    }
  }

  const revenueByDate = new Map<string, number>(
    (revenueSeriesAgg as { _id: string; sum: number }[]).map((entry) => [entry._id, entry.sum])
  );

  const revenueSeries = Array.from({ length: 14 }, (_, i) => {
    const date = startOfUtcDay(new Date(chartStart.getTime() + i * DAY_MS));
    const key = formatUtcDate(date);
    return { date: key, revenue: Number((revenueByDate.get(key) ?? 0).toFixed(2)) };
  });

  const revenueCurrent = revenueCurrentAgg[0]?.sum ?? 0;
  const revenuePrevious = revenuePreviousAgg[0]?.sum ?? 0;

  return {
    totals: {
      revenue: Number((revenueTotalAgg[0]?.sum ?? 0).toFixed(2)),
      orders: ordersTotal,
      users: usersTotal,
      products: productsTotal,
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
