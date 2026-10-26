// What the agent suite's server sends out, captured instead of sent, and the switch that makes a
// service keep failing for stuck cases (spec 020). Test files register these with vi.mock, e.g.
//   vi.mock('../../src/config/stripe.js', async () => (await import('./mocks')).stripe());

export const failing = { orders: false, search: false };
export const outside = { stripeSessions: 0, support: [] as Record<string, unknown>[] };

const unavailable = (service: string) => new Error(`${service} is unavailable (eval stub)`);

export const stripe = () => ({
  stripeClient: {
    checkout: {
      sessions: {
        create: async () => {
          outside.stripeSessions += 1;
          const id = `cs_test_agent_eval_${outside.stripeSessions}`;
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
      },
    },
    webhooks: { constructEvent: () => null },
  },
});

export const email = () => ({ sendOrderConfirmationEmail: async () => {} });

export const support = () => {
  class SupportDeliveryError extends Error {}
  return {
    SupportDeliveryError,
    submitSupportRequest: async (request: Record<string, unknown>) => {
      outside.support.push(request);
    },
  };
};

export const alerts = () => ({ raiseAlert: async () => {} });

type Fn = (...args: never[]) => Promise<unknown>;
const failWhen = <F extends Fn>(flag: keyof typeof failing, service: string, fn: F): F =>
  (async (...args: Parameters<F>) => {
    if (failing[flag]) throw unavailable(service);
    return fn(...args);
  }) as F;

export const orderService = <M extends { getMyOrders: Fn; getMyOrderById: Fn }>(actual: M): M => ({
  ...actual,
  getMyOrders: failWhen('orders', 'The order service', actual.getMyOrders),
  getMyOrderById: failWhen('orders', 'The order service', actual.getMyOrderById),
});

export const productService = <M extends { getAllProductsService: Fn }>(actual: M): M => ({
  ...actual,
  getAllProductsService: failWhen('search', 'Product search', actual.getAllProductsService),
});
