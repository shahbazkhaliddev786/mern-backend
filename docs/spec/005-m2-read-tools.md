# 005 — Read tools

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M2 — Agent core, read-only ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | `2f97266` |

## Goal

The six read tools from [`architecture.md`](../shopping-agent/architecture.md) §4 exist as LangChain tools, built per request by `buildToolsForRequest(ctx)` with the verified user's id closed over, each wrapping an existing store service. They're fully tested without a model. Spec 006 plugs them into the graph and the chat endpoint.

## Context

- **Tools in this spec:** `search_products`, `get_product_details`, `view_cart`, `view_orders`, `get_order_status`, `view_profile`. The write tools come in M4, `ask_store_knowledge` in M5.
- **Rules they follow:**
  - **Identity:** `userId` is in no tool schema; it comes from a closure over the verified session ([`security.md`](../shopping-agent/security.md) §3).
  - **Ownership:** every query is scoped to the owner, and another user's order looks the same as a missing one (§4).
  - **Untrusted text:** product text is wrapped as data, never instructions (§5).
  - **Validation:** Zod validates every argument (§7).
  - **Minimal data:** the output carries only what the task needs (§9).
- **Spec 001 rules:** schemas are sent with `strict: true` (so `additionalProperties: false`), and the tool list and descriptions are static so the prompt cache holds.
- **What the services offer today:**

| Service | Fit | Gap the tool fills |
|---|---|---|
| `getAllProductsService({ search, category, brand, minPrice, maxPrice, sort, page, limit })` | Catalog query with populate | Takes category/brand **ids** (the model knows names); `search` goes into `new RegExp` unescaped, so `(` throws ([`follow-ups.md`](../shopping-agent/follow-ups.md) §6); no in-stock filter; sort values `newest \| price_low \| price_high` |
| `getProductByIdService(id)` | Product with category and brand names | Related products are computed in the frontend, not the backend |
| `getCart(userId)` | Items with product name, price, stock; `itemsCount`, `subtotal` | Creates an empty cart if none exists (harmless) |
| `getMyOrders(userId)` | All the user's orders, newest first | No status filter (the tool filters) |
| `getOrderById(orderId)` | — | **Not owner-scoped**; the tool needs a new `getMyOrderById(userId, orderId)` |
| `getUserById(userId)` | The user document | Returns the whole document; the tool picks fields |

## Scope

**In:**
- `src/agent/tools/`: one file per tool, `index.ts` with `buildToolsForRequest(ctx)`, `untrusted.ts`, shared output helpers.
- Two small additive service changes, defaults unchanged so the REST API behaves as before:
  - `getAllProductsService` gains an optional `inStock?: boolean` filter (`stock > 0`).
  - `order.service.ts` gains `getMyOrderById(userId, orderId)` (owner-scoped `findOne`).
- `src/validations/product-query.schema.ts`: the Zod schema for a product query, used by `search_products`.
- Unit tests for every tool.

**Out:**
- The graph, prompt and endpoint (spec 006).
- Adopting the product-query schema in the REST route, and escaping regexes in the REST path ([`follow-ups.md`](../shopping-agent/follow-ups.md) §6) — the tool escapes its own input; the REST route is unchanged.
- Write tools (M4) and `ask_store_knowledge` (M5).

## Design

**Context and factory** (`src/agent/tools/index.ts`):

```ts
export interface ToolContext { userId: string }          // from the verified req.user._id, never from the model
export function buildToolsForRequest(ctx: ToolContext): StructuredTool[]
export const READ_TOOL_NAMES = [...] as const
```

- Tool names, descriptions and schemas are module constants, identical for every user and request; only the closure differs.
- Each tool carries `metadata: { kind: 'read', confirmRequired: false }`, which the M4 gate reads.

**Output conventions:**
- Each tool returns a compact JSON string. Money values are numbers in USD. Product links are relative paths (`/products/:id`) that the chat UI can render.
- **Errors never throw to the model.** Bad input the schema didn't catch, a missing record or a service failure returns `{ "error": "<plain sentence>" }`. Unexpected errors are logged (`AGENT_TOOL_ERROR`, tool name and user id; no arguments that might hold personal data) and return a generic message.
- **Untrusted text** (product descriptions) goes through `untrusted(source, text)`, which wraps it as `<untrusted_content source="product_description">…</untrusted_content>` and neutralises any closing tag inside the text. The system prompt (spec 006) says content inside these tags is data, never instructions.

**Tools:**

| Tool | Arguments (Zod, all optional unless noted) | Does | Returns |
|---|---|---|---|
| `search_products` | `query` (≤ 100 chars), `categories` (names, ≤ 5), `brands` (names, ≤ 5), `min_price`, `max_price` (≥ 0), `in_stock` (bool), `sort` (`newest \| price_asc \| price_desc`), `page` (1–20) | Escapes `query` for regex; resolves category/brand **names** to ids (case-insensitive exact match; unknown names are reported back, not guessed); maps sort to `newest \| price_low \| price_high`; calls `getAllProductsService` with `limit: 8` | `{ results: [{ id, name, price, inStock, stock, category, brand, url }], page, totalPages, totalItems, unknownCategories?, unknownBrands? }` — no descriptions in lists |
| `get_product_details` | `product_id` (**required**, 24-hex) | `getProductByIdService`; related = up to 4 other products from the same category via `getAllProductsService({ category, limit: 5 })` | `{ id, name, price, stock, inStock, category, brand, images (≤ 3), url, description: untrusted(...), related: [{ id, name, price, url }] }`. A missing product → `{ error: "No product with that id." }` |
| `view_cart` | none | `getCart(ctx.userId)`; totals from `computeOrderPricing(subtotal)` | `{ items: [{ productId, name, unitPrice, quantity, lineTotal, stock }], itemsCount, subtotal, shipping: 0, tax: 0, total }` |
| `view_orders` | `status` (`pending \| processing \| shipped \| delivered \| cancelled`) | `getMyOrders(ctx.userId)`, filtered by status, newest 10 | `{ orders: [{ orderId, placedAt, status, paymentStatus, itemsCount, total, items: [names] }], totalMatching }` — no shipping addresses |
| `get_order_status` | `order_id` (**required**, 24-hex) | `getMyOrderById(ctx.userId, order_id)` | `{ orderId, placedAt, status, paymentStatus, paidAt?, deliveredAt?, items: [{ name, quantity, price }], subtotal, shipping, tax, total, shipTo: { city, country } }`; another user's or a missing order → `{ error: "No order with that id on your account." }` |
| `view_profile` | none | `getUserById(ctx.userId)` | `{ name, email, emailVerified, hasProfilePicture, memberSince }` — no role, tokens or pending-email fields |

**`getMyOrderById(userId, orderId)`** (in `order.service.ts`): returns `null` for an invalid id, or for an order not owned by `userId`, via `Order.findOne({ _id: orderId, user: userId }).lean()`. Nothing in the REST API changes to use it in this spec.

**Strict mode and optional fields:** schemas use optional properties. If the live run of spec 001 shows strict tools reject them, switch to required-but-nullable fields; that's a schema-only change.

## Tasks

- [x] `untrusted.ts` + output helpers (one file: `src/agent/tools/helpers.ts`)
- [x] `product-query.schema.ts`
- [x] `getAllProductsService`: optional `inStock`
- [x] `getMyOrderById` in `order.service.ts`
- [x] The six tool files and `buildToolsForRequest`
- [x] Unit tests (below)
- [x] Update the spec index and `phases.md` §0

## Acceptance criteria

- [x] No tool schema contains a `userId`, `user_id` or `user` property at any depth — `tools.test.ts` walks every tool's JSON schema
- [x] Every service call receives `ctx.userId` from the closure — two contexts, each call checked against its own id
- [x] `get_order_status` for another user's order and for a missing order return the identical error — unit test, and against MongoDB with two real users
- [x] `search_products` with `query: "("` or `"a.*b"` doesn't throw and matches literally — unit test (escaped arg) and MongoDB (`(Runner)` finds one product, `.*` finds none)
- [x] Category/brand names resolve to ids; unknown names come back in `unknownCategories` / `unknownBrands` — tests; when every requested name is unknown, no search runs
- [x] Zod rejects out-of-range or malformed arguments (negative price, page 0, bad id, query over 100 chars, unknown sort) — test
- [x] Product descriptions are wrapped, and a description containing `</untrusted_content>` can't close the wrapper — test
- [x] Tool definitions are identical across contexts (name, description, JSON schema, metadata) — test
- [x] REST behaviour unchanged: existing tests pass; without `inStock` the service still returns sold-out products — MongoDB test
- [x] `npm run lint` (0 errors), `npm run build`, `npm test` pass

## Test plan

Unit tests in `src/agent/tools/*.test.ts`, mocking the models/services the way the existing service tests do (`vi.mock`), so no database is needed. One extra test runs `search_products` and `get_order_status` against the local MongoDB 7 from spec 002 when `MONGO_URL` is set, and skips otherwise, to check the real queries (regex escaping, owner scope).

## Open questions

_None — resolved 2026-10-10, see the decision log._

## Results

**2026-10-10**
- `npm test`: 78 passed, 6 skipped (the MongoDB file skips without `MONGO_URL`). With `MONGO_URL=mongodb://127.0.0.1:27017` (local MongoDB 7): **84/84**.
- New: `src/agent/tools/tools.test.ts` (20 unit tests, services mocked) and `tools.mongo.test.ts` (6 tests against real queries).
- Lint 0 errors, still 106 warnings (all existing); `npm run build` clean.

Files: `src/agent/tools/{types,helpers,index,search-products,get-product-details,view-cart,view-orders,get-order-status,view-profile}.ts`, `src/validations/product-query.schema.ts`; `getAllProductsService` gains `inStock`; `order.service.ts` gains `getMyOrderById`.

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-10-10 | Approved ("code m2"). `search_products` returns 8 results per page | Keeps the model's context small and replies readable; the customer can ask for more |
| 2026-10-10 | `untrusted()` and the output helpers live together in `src/agent/tools/helpers.ts` | Small enough for one file; nothing else imports them yet |
| 2026-10-10 | When every requested category (or brand) name is unknown, `search_products` returns no results plus the unknown names instead of searching the whole catalog | Searching everything would answer a different question than the customer asked |
| 2026-10-10 | Cart items whose product was deleted are left out of `view_cart` | The populated product is `null`; there's nothing to show or price |
| 2026-10-10 | The two test helpers that parse tool JSON keep `Record<string, any>` with a lint-disable comment | Assertions read nested fields freely; typing every shape would add casts without catching anything |
