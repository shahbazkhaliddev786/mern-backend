import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addToCart, clearCart, getCart, removeFromCart, updateCartItem } from './cart.service';
import { addToGuestCart, clearGuestCart, mergeGuestCartOnLogin, updateGuestCartItem } from './guest-cart.service';

// In-memory stand-ins for the Cart and Product models, so the cart services run
// without a database. Only the calls the services make are implemented.
const db = vi.hoisted(() => {
  type Item = { product: { toString(): string }; quantity: number };
  type StoredCart = { user: string; items: Item[]; save(): Promise<unknown>; toObject(): object };

  const products = new Map<string, { _id: string; name: string; price: number; stock: number }>();
  const carts = new Map<string, StoredCart>();

  const createCart = (user: string, items: Item[]) => {
    const cart: StoredCart = {
      user,
      items,
      async save() {
        carts.set(user, cart);
        return cart;
      },
      toObject() {
        return { user, items: cart.items };
      },
    };
    return cart;
  };

  // What `.populate(CART_ITEM_POPULATE)` produces: each item's product id replaced by the product.
  const populated = (cart: StoredCart) => ({
    ...cart,
    items: cart.items.map((item) => ({ product: products.get(item.product.toString()), quantity: item.quantity })),
  });

  const Cart = {
    findOne: ({ user }: { user: string }) => {
      const cart = carts.get(user) ?? null;
      return {
        populate: async () => (cart ? populated(cart) : null),
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(cart).then(resolve, reject),
      };
    },
    create: async ({ user, items }: { user: string; items: Item[] }) => {
      const cart = createCart(user, items);
      carts.set(user, cart);
      return cart;
    },
  };

  const Product = {
    findById: async (id: string) => products.get(id) ?? null,
    find: ({ _id }: { _id: { $in: string[] } }) => ({
      select: () => ({
        populate: async () => _id.$in.map((id) => products.get(id)).filter(Boolean),
      }),
    }),
  };

  return { products, carts, Cart, Product };
});

vi.mock('../models/index.js', () => ({ Cart: db.Cart, Product: db.Product }));

const USER = '64a000000000000000000001';
const SHIRT = '64b000000000000000000001';
const MUG = '64b000000000000000000002';
const UNKNOWN = '64b0000000000000000000ff';

// [productId, quantity] per cart line, in order.
const lines = (cart: { items: { product: { _id: string }; quantity: number }[] }) =>
  cart.items.map((item) => [item.product._id, item.quantity]);

beforeEach(() => {
  db.carts.clear();
  db.products.clear();
  db.products.set(SHIRT, { _id: SHIRT, name: 'Linen Shirt', price: 40, stock: 5 });
  db.products.set(MUG, { _id: MUG, name: 'Clay Mug', price: 12.5, stock: 10 });
});

describe('signed-in cart (keyed by userId)', () => {
  it('creates an empty cart on first read', async () => {
    expect(await getCart(USER)).toMatchObject({ itemsCount: 0, subtotal: 0 });
    expect(db.carts.has(USER)).toBe(true);
  });

  it('merges repeat adds and totals from product prices', async () => {
    await addToCart(USER, SHIRT, 2);
    const cart = await addToCart(USER, SHIRT, 1);

    expect(lines(cart)).toEqual([[SHIRT, 3]]);
    expect(cart).toMatchObject({ itemsCount: 3, subtotal: 120 });
  });

  it('enforces stock, including after merging, and rejects unknown products', async () => {
    await expect(addToCart(USER, SHIRT, 6)).rejects.toThrow('Insufficient stock');
    await addToCart(USER, SHIRT, 4);
    await expect(addToCart(USER, SHIRT, 2)).rejects.toThrow('Not enough stock');
    await expect(addToCart(USER, UNKNOWN, 1)).rejects.toThrow('Product not found');
  });

  it('updates a quantity, and quantity 0 removes the item', async () => {
    await addToCart(USER, SHIRT, 1);
    await addToCart(USER, MUG, 1);

    expect(lines(await updateCartItem(USER, MUG, 4))).toEqual([
      [SHIRT, 1],
      [MUG, 4],
    ]);
    expect(lines(await updateCartItem(USER, SHIRT, 0))).toEqual([[MUG, 4]]);
  });

  it('removes one item and clears the whole cart', async () => {
    await addToCart(USER, SHIRT, 1);
    await addToCart(USER, MUG, 2);

    expect(lines(await removeFromCart(USER, SHIRT))).toEqual([[MUG, 2]]);
    expect(await clearCart(USER)).toMatchObject({ itemsCount: 0, subtotal: 0 });
  });
});

describe('guest cart (session)', () => {
  it('keeps items in the session and totals them like a signed-in cart', async () => {
    const session: any = {};

    await addToGuestCart(session, MUG, 2);
    const cart = await updateGuestCartItem(session, MUG, 3);

    expect(session.cart.items).toEqual([{ product: MUG, quantity: 3 }]);
    expect(cart).toMatchObject({ itemsCount: 3, subtotal: 37.5 });
    expect(await clearGuestCart(session)).toMatchObject({ itemsCount: 0, subtotal: 0 });
  });

  it('merges into the account cart on sign-in, then empties the session cart', async () => {
    const session: any = { save: (done: (err?: unknown) => void) => done() };
    await addToCart(USER, SHIRT, 1);
    await addToGuestCart(session, SHIRT, 2);
    await addToGuestCart(session, MUG, 1);

    await mergeGuestCartOnLogin(USER, session);

    expect(lines(await getCart(USER))).toEqual([
      [SHIRT, 3],
      [MUG, 1],
    ]);
    expect(session.cart.items).toEqual([]);
  });
});
