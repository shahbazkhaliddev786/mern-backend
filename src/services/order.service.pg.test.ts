// Orders against Postgres (spec 023): the webhook creates the order, ends the pending checkout and
// empties the cart together; a redelivered or doubled event creates one order and never fails;
// stock is deducted once and all-or-nothing, even when two status changes race.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { brands, cartItems, carts, categories, orders, pendingCheckouts, products, users } from '../db/schema/index';
import { createTestDatabase, holdLocks, TEST_DATABASE_URL, type TestDatabase } from '../db/test-db';
import { addToCart, getCart } from './cart.service';
import { getAllOrdersService } from './admin-order.service';
import { createCheckoutSession, getMyOrders, getOrderById, handleStripeWebhook, updateOrderStatus } from './order.service';

if (process.env.CI === 'true' && !TEST_DATABASE_URL) throw new Error('The Postgres tests need TEST_DATABASE_URL in CI (spec 023).');

const stripe = vi.hoisted(() => ({ created: 0, event: null as unknown }));
vi.mock('../config/stripe.js', () => ({
  stripeClient: {
    checkout: {
      sessions: {
        create: async () => {
          stripe.created += 1;
          return { id: `cs_test_order_${stripe.created}`, url: `https://checkout.stripe.com/c/pay/cs_test_order_${stripe.created}` };
        },
      },
    },
    webhooks: { constructEvent: () => stripe.event },
  },
}));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; orderId: string }[] }));
vi.mock('../utils/order.confirmation.email.js', () => ({
  sendOrderConfirmationEmail: async (to: string, order: { _id: string }) => void mail.sent.push({ to, orderId: order._id }),
}));

const address = { fullName: 'Jane Doe', address: '1 Main St', city: 'Lahore', postalCode: '54000', country: 'Pakistan' };

describe.skipIf(!TEST_DATABASE_URL)('orders on Postgres', () => {
  let testDb: TestDatabase;
  let userId = '';
  let mug = '';
  let bowl = '';

  /** Checks out the cart and delivers Stripe's completed event for it. */
  const checkout = async () => {
    const { sessionId } = await createCheckoutSession(userId, address);
    return sessionId;
  };
  const deliver = (sessionId: string) => {
    stripe.event = { type: 'checkout.session.completed', data: { object: { id: sessionId, metadata: { userId } } } };
    return handleStripeWebhook(Buffer.from('{}'), 'sig');
  };
  const ordersFor = async (sessionId: string) => getDb().select().from(orders).where(eq(orders.stripeSessionId, sessionId));
  const stockOf = async (id: string) => (await getDb().select({ stock: products.stock }).from(products).where(eq(products.id, id)))[0]!.stock;

  beforeAll(async () => {
    testDb = await createTestDatabase('orders');
    const [user] = await getDb().insert(users).values({ name: 'Jane', email: 'jane.orders@example.com', password: 'hash', isVerified: true }).returning();
    userId = user!.id;
    const [category] = await getDb().insert(categories).values({ name: 'Home' }).returning();
    const [brand] = await getDb().insert(brands).values({ name: 'Aljo' }).returning();
    const made = await getDb()
      .insert(products)
      .values([
        { name: 'Clay Mug', description: 'A mug.', price: 12.5, stock: 5, categoryId: category!.id, brandId: brand!.id, images: ['https://img/mug.png'] },
        { name: 'Stone Bowl', description: 'A bowl.', price: 30, stock: 5, categoryId: category!.id, brandId: brand!.id },
      ])
      .returning();
    mug = made[0]!.id;
    bowl = made[1]!.id;
  }, 60_000);

  beforeEach(async () => {
    await getDb().delete(orders);
    await getDb().delete(pendingCheckouts);
    await getDb().delete(carts);
    await getDb().update(products).set({ stock: 5 });
    mail.sent = [];
    await addToCart(userId, mug, 2);
    await addToCart(userId, bowl, 1);
  });

  afterAll(async () => {
    await testDb?.drop();
  });

  describe('the Stripe webhook', () => {
    it('creates the order from the pending checkout, ends it, empties the cart and emails the customer', async () => {
      const session = await checkout();
      await expect(deliver(session)).resolves.toEqual({ received: true });

      const [order] = await ordersFor(session);
      expect(order).toMatchObject({ userId, status: 'pending', paymentStatus: 'paid', subtotal: 55, total: 55 });
      expect(order!.items.map((item) => [item.product, item.quantity, item.image])).toEqual([
        [mug, 2, 'https://img/mug.png'],
        [bowl, 1, ''],
      ]);
      expect(await getDb().select().from(pendingCheckouts)).toHaveLength(0);
      expect(await getCart(userId)).toMatchObject({ itemsCount: 0 });
      expect(mail.sent).toEqual([{ to: 'jane.orders@example.com', orderId: order!.id }]);
    });

    it('a redelivered event creates nothing more', async () => {
      const session = await checkout();
      await deliver(session);
      await deliver(session);

      expect(await ordersFor(session)).toHaveLength(1);
      expect(mail.sent).toHaveLength(1);
    });

    it('two deliveries at once create one order, and neither fails (Stripe would retry a 500)', async () => {
      const session = await checkout();
      // Holding the cart makes the first delivery wait before committing, so the second one
      // reaches its own insert while the first order is still uncommitted.
      const [cart] = await getDb().select().from(carts).where(eq(carts.userId, userId));
      const blocker = await holdLocks(testDb.url, (client) => client.query('SELECT id FROM carts WHERE id = $1 FOR UPDATE', [cart!.id]));
      const both = Promise.allSettled([deliver(session), deliver(session)]);
      await blocker.releaseWhen(2);

      expect((await both).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await ordersFor(session)).toHaveLength(1);
    });

    it('ignores a session with no pending checkout', async () => {
      await expect(deliver('cs_unknown')).resolves.toEqual({ received: true });
      expect(await getDb().select().from(orders)).toHaveLength(0);
    });
  });

  describe('updateOrderStatus', () => {
    const placeOrder = async () => {
      const session = await checkout();
      await deliver(session);
      return (await ordersFor(session))[0]!.id;
    };

    it('deducts stock once when the order ships, not again when it is delivered', async () => {
      const orderId = await placeOrder();

      const shipped = await updateOrderStatus(orderId, 'shipped');
      await updateOrderStatus(orderId, 'delivered');

      expect([await stockOf(mug), await stockOf(bowl)]).toEqual([3, 4]);
      // Products as they were before the deduction, as Mongoose's populate returned them.
      expect(shipped.items[0]!.product).toMatchObject({ _id: mug, stock: 5, category: expect.any(String) });
    });

    it('deducts once even when two status changes arrive at once', async () => {
      const orderId = await placeOrder();
      // Holding the mug's row stops the first change at its deduction; only the order's row
      // lock keeps the second from reading the order as still pending.
      const blocker = await holdLocks(testDb.url, (client) => client.query('UPDATE products SET stock = stock WHERE id = $1', [mug]));
      const both = Promise.allSettled([updateOrderStatus(orderId, 'shipped'), updateOrderStatus(orderId, 'shipped')]);
      await blocker.releaseWhen(2);

      expect((await both).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect([await stockOf(mug), await stockOf(bowl)]).toEqual([3, 4]);
    });

    it('deducts nothing and keeps the status when one product is short', async () => {
      const orderId = await placeOrder();
      await getDb().update(products).set({ stock: 0 }).where(eq(products.id, bowl));

      await expect(updateOrderStatus(orderId, 'shipped')).rejects.toThrow('Insufficient stock for one or more products');

      expect(await stockOf(mug)).toBe(5);
      expect((await getOrderById(orderId)).status).toBe('pending');
    });

    it('says the order is not found for an unknown or malformed id', async () => {
      await expect(updateOrderStatus('00000000-0000-4000-8000-000000000000', 'shipped')).rejects.toThrow('Order not found');
      await expect(updateOrderStatus('nope', 'shipped')).rejects.toThrow('Order not found');
    });
  });

  it("keeps a deleted customer's orders, with no user", async () => {
    const [other] = await getDb().insert(users).values({ name: 'Gone', email: 'gone@example.com', password: 'hash' }).returning();
    const [order] = await getDb()
      .insert(orders)
      .values({ userId: other!.id, items: [], subtotal: 10, total: 10, shippingAddress: address, paymentStatus: 'paid' })
      .returning();
    await getDb().delete(users).where(eq(users.id, other!.id));

    expect(await getOrderById(order!.id)).toMatchObject({ _id: order!.id, user: null });
    expect((await getAllOrdersService({})).orders).toEqual([expect.objectContaining({ _id: order!.id, user: null })]);
    expect(await getMyOrders(userId)).toEqual([]);
    expect(await getDb().select().from(cartItems).where(eq(cartItems.productId, mug))).toHaveLength(1);
  });
});
