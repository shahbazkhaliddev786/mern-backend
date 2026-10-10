# 010 — place_order

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M4 — Write tools + confirmation gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | `d7ad0af` + `mern-frontend` `d5ff830` |
| **Repo** | `mern-backend`; one small change in `mern-frontend` (the Stripe link) |

## Goal

A customer can ask the agent to check out. After they confirm a server-written summary (items, total, shipping address), the agent returns a Stripe Checkout link and they pay on Stripe's page. The order is created by the existing webhook after payment. Asking twice for the same cart and address returns the same link, not a second checkout.

## Context

- **Design:** [`architecture.md`](../shopping-agent/architecture.md) §3 step 7 and §4 (`place_order` row); [`security.md`](../shopping-agent/security.md) §7–§10; [`reconciliation.md`](../shopping-agent/reconciliation.md) Gaps 1 and 5.
- **What exists:**
  - `createCheckoutSession(userId, shippingAddress)` in `src/services/order.service.ts`. From the user's cart, it creates a Stripe Checkout session and a `PendingCheckout` (24 h TTL), with money from `computeOrderPricing`, and returns `{ sessionId, url }`.
  - The Stripe webhook creates the paid `Order` and clears the cart. The webhook is idempotent on the session id.
  - The `/checkout` page uses the same function.
  - `shippingSchema` in `src/validations/shipping.schema.ts` is the shared Zod address schema.
  - The confirmation gate and card from specs 008–009.
- **What's missing:**
  - The tool itself.
  - The duplicate-checkout guard. `PendingCheckout` stores neither a cart fingerprint nor the checkout URL.
  - A way to show a Stripe link in the chat. Spec 007 renders every non-store link as plain text.
- **Rules that apply:**
  - The total is never a model argument (security.md §8).
  - The address is validated with the checkout form's schema and shown in full in the confirmation (§7).
  - The agent never sees card data (§9).
  - The duplicate key is derived on the server, never a tool argument (§10).
  - Stripe only; there is no cash-on-delivery flow.

## Scope

**In:**
- The `place_order` tool (confirm-required), its confirmation summary, and the duplicate guard.
- Two additive `PendingCheckout` fields.
- A prompt update and a `PROMPT_VERSION` bump.
- Frontend: the chat renders Stripe Checkout links as real links.

**Out:**
- Changing the `/checkout` page or its API. The guard applies to the agent's path only; the shared `createCheckoutSession` keeps its behaviour and only saves the two new fields.
- Stock reservation ([`follow-ups.md`](../shopping-agent/follow-ups.md) §4).
- Cash on delivery.

## Design

**Tool** (`src/agent/tools/place-order.ts`, metadata `{ kind: 'write', confirmRequired: true }`):

```ts
place_order({ shipping_address?: ShippingAddress })   // the /checkout form's fields; shippingSchema validates them
```

- **No address given** → the address of the customer's most recent order is used (`getMyOrders(ctx.userId)[0].shippingAddress`). No previous order either → `{ error: "I need a shipping address: full name, street address, city, postal code and country." }`, and the model asks the customer.
- **The model never sends money values**: the schema has no price or total fields.
- **Empty cart** → `{ error: "Your cart is empty." }` before anything is created.

**Confirmation summary** (computed from the cart and the resolved address, read-only):
> Place an order for 3 items ($142.50) — Trail Runner ×2, Road Lite ×1 — shipping to Jane Doe, 1 Main St, Apt 4, Lahore, Punjab 54000, Pakistan? You'll pay by card on Stripe's secure page.

The address in the summary is the one that will be used, so an address injected or invented by the model is visible to the customer before anything happens.

**Duplicate guard** (`order.service.ts`, new `createOrReuseCheckoutSession(userId, shippingAddress)`):
- `cartHash` is sha256 of the cart's sorted `productId:quantity` pairs plus the normalised address.
- If a `PendingCheckout` exists with `{ user, cartHash }` created in the last **23 hours** (inside Stripe's 24 h session life), its stored `checkoutUrl` is returned with `reused: true`.
- Otherwise it calls `createCheckoutSession`.
- `PendingCheckout` gains optional `cartHash` and `checkoutUrl` fields, which `createCheckoutSession` now saves. They're additive; existing documents and the `/checkout` page behave as before.

**Tool result:** `{ checkoutUrl, itemsCount, total, reused }`.
- The prompt tells the model to give the customer the link, and to say the order is placed only after payment on Stripe.
- `ORDER_CHECKOUT` is audit-logged with the user id, `PendingCheckout` id, `reused` and total. No address goes in the log.

**Prompt:** the assistant can now start checkout with `place_order`. It should:
- use the saved address unless the customer gives a new one
- never ask for card details
- share the Stripe link as a Markdown link

`PROMPT_VERSION` becomes 3.

**Frontend** (`AssistantMessage.tsx`): links to `https://checkout.stripe.com/` render as external links (`target="_blank"`, `rel="noopener noreferrer"`). Every other non-store link stays plain text.

## Tasks

- [x] `PendingCheckout`: `cartHash`, `checkoutUrl`; `createCheckoutSession` saves them
- [x] `createOrReuseCheckoutSession` + `computeCartHash`
- [x] `place_order` tool, address fallback, summary, audit log; prompt + `PROMPT_VERSION` 3; tool label
- [x] Frontend: Stripe links
- [x] Tests (below)
- [x] Update `phases.md` §0 and the spec index

## Acceptance criteria

- [x] `place_order` pauses with a summary listing items, the server total and the full address that will be used — the gate covers every confirm-required tool (spec 008 tests); summary tested in `tools.test.ts`
- [x] On confirm it returns a Stripe link; no `Order` is created here (the webhook path is unchanged) — tool test
- [x] The same cart and address again → the same link with `reused: true` and no new Stripe session; a changed cart or address → a new session; older than 23 h → new; another customer → never reused — `checkout-reuse.mongo.test.ts`
- [x] No address → the last order's address; none → the plain error; an invalid address → rejected by `shippingSchema` — tests
- [x] Empty cart → error, no Stripe call — tests (tool and MongoDB)
- [x] No price, total or user field in the tool schema — the schema test walks all tools
- [x] `/checkout` (REST) unchanged apart from saving the two new fields — existing tests pass; MongoDB test checks the saved fields
- [x] Frontend: a `checkout.stripe.com` link opens in a new tab; a look-alike host stays text — test
- [x] Backend lint 0 errors, build, `npm test` 121 + 14 skipped / 135 with `MONGO_URL`; frontend 54 tests, ESLint 0 errors, Prettier, build

## Test plan

- **Tool and graph tests:** mocked services and Stripe.
- **Duplicate guard:** a MongoDB test with the Stripe client mocked (no Stripe key in this environment).
- **Frontend:** a test in `chat-panel.test.tsx`.
- **Not in this spec:** a real Stripe test-mode run. That needs a Stripe test key and is noted for the live check alongside the Anthropic key.

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**2026-10-10** — backend in this repo; frontend `mern-frontend` `d5ff830`.
- New tests: 7 `place_order` tool tests; `src/services/checkout-reuse.mongo.test.ts` (6, Stripe mocked); 1 frontend link test.
- Example confirmation: *"Place an order for 3 items ($142.50) — Trail Runner ×2, Road Lite ×1 — shipping to Jane Doe, 1 Main St, Apt 4, Lahore, Punjab 54000, Pakistan? You'll pay by card on Stripe's secure page."*
- Not yet run: a real Stripe test-mode checkout (needs a Stripe test key), alongside the parked real-model check.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved. Without an address from the customer, `place_order` uses the last order's address | The confirmation shows that address in full before anything happens |
| 2026-10-10 | The duplicate-checkout guard applies to the agent only | No change to the `/checkout` page's behaviour |
| 2026-10-10 | The cart fingerprint ignores item order and the address's case and surrounding spaces | "Lahore" and " lahore " are the same address; a reordered cart is the same cart |
| 2026-10-10 | When the customer gives no address and the last order's address is incomplete, it isn't used (`shippingSchema` must pass) | Older orders can hold partial addresses ([`follow-ups.md`](../shopping-agent/follow-ups.md) §3); the customer is asked instead |
| 2026-10-10 | The confirmation summary lists up to 5 items, then "and N more" | Keeps the card readable for big carts; the total covers everything |
| 2026-10-10 | Only links starting with `https://checkout.stripe.com/` become links in the chat | A prefix check on the full origin plus path, so look-alike hosts (`checkout.stripe.com.evil.example`) stay text |
