# AI Shopping Assistant — Docs ↔ Code Reconciliation

> **Purpose:** the design docs ([`architecture.md`](./architecture.md), [`tech-stack.md`](./tech-stack.md), [`security.md`](./security.md), [`observability.md`](./observability.md), [`evals.md`](./evals.md)) describe the *target* agent. This file records where the design diverges from the **existing MERN codebase**, two real bugs found while reading that code, and the agreed fix for each. It is the bridge between the clean diagram and the messier code that already ships.
>
> **Status:** the AI shopping agent is 100% design-stage — **no agent code exists yet**. The MERN store (auth, products, cart, orders, Stripe checkout, admin) is fully implemented and is what the agent will sit on top of.
>
> **Governing principle for all fixes:** the existing code is the source of truth where it is sound — **align the docs to it**. Change code only for real bugs and the one genuinely-new capability (`cancel_order`).

---

## 0. What the real code actually does (payment path)

Ground truth from the backend, so the fixes below are concrete:

*(Line references refreshed 2026-10-10.)*

- `createCheckoutSession(userId, shippingAddress)` (`mern-backend/src/services/order.service.ts:31`) creates a **Stripe Checkout Session + a `PendingCheckout` snapshot**, with money from `computeOrderPricing` (`:61`). **No `Order` is created here.**
- The `Order` is created **only** in `handleStripeWebhook` on `checkout.session.completed` (`order.service.ts:115`), as `status: 'pending', paymentStatus: 'paid', paidAt`.
- **Idempotency already exists** and is the **Stripe session id** (server-generated): checked at the webhook (`order.service.ts:102`) and enforced `unique`/`sparse` on the model (`order.model.ts:92`).
- `PendingCheckout` auto-expires 24h after creation (`pending-checkout.model.ts:52`).

**Implication:** the existing flow is **payment-first**, not the doc's **order-first**. It is the *better* of the two — `PendingCheckout` + its TTL already is the "trackable, idempotent, auto-expiring pre-order" the doc wanted, without littering the DB with abandoned `Unpaid` orders.

---

## 1. Real bugs found in existing code — ✅ both fixed

> Fixed on the `feature/shopping-agent` branch (commit `b310fc1`, 2026-10-10) and unit-tested. The descriptions and line numbers below are the code *as it was*.

### Bug A — Money is not fully server-side — ✅ FIXED
**Fixed:** `computeOrderPricing(cart.subtotal)` in `src/services/pricing.service.ts` (v1 rule: $0 tax, free shipping) is the only source of checkout money; `tax`/`shipping`/`total` in the request body are ignored. Admin edits go through the same `computeOrderTotal` formula (follow-ups §1).

**Was:** `tax` and `shipping` were read from `req.body` and trusted into the total (`order.service.ts:57` and `:77` at the time):
```ts
const { shippingAddress, tax = 0, shipping = 0 } = req.body;
...
total: cart.subtotal + Number(tax) + Number(shipping),
```
A client can POST `tax=0`. This **violates `security.md` §8 (Defense 6 — money computed server-side)** before the agent even exists.

**Fix:** compute `tax` and `shipping` server-side from cart + store rules. Remove them from the trusted request body (or validate against the server-computed values). The LLM/`place_order` must never supply them.

### Bug B — `shippingAddress` is never validated server-side — ✅ FIXED
**Fixed:** a backend zod `shippingSchema` (`src/validations/shipping.schema.ts`, mirroring the frontend's, now with optional `apartment` and `state` — Gap 2) validates the body of `POST /orders/checkout` through `validateBody` (`src/routes/order.routes.ts:28`).

**Was:** `createOrderValidation` (`mern-backend/src/validations/order.validations.ts`) validates only `tax`/`shipping`. The address is written straight into `PendingCheckout` unvalidated. The doc's "same Zod schema as `/checkout`" promise isn't just drift — **the server-side half does not exist.**

**Fix:** add a backend Zod `shippingSchema` (mirroring the frontend's 6 fields) and validate the address in the checkout path. Closes this bug and delivers the "one schema, no drift" promise simultaneously (see Gap 2).

---

## 2. Design gaps (docs vs. code) and agreed solutions

### Gap 1 — Payment-flow mismatch (order-first vs. payment-first)

**Divergence:** the doc's `place_order` creates an `Order` first (`Pending/Unpaid`) then hands off; the code creates the `Order` only after the webhook confirms payment.

**Decision:** **align the doc to the code.** Make `place_order` a thin wrapper over the existing `createCheckoutSession` path — one payment path for UI and agent (the real "no drift" win):

1. Validate `shippingAddress` with the shared Zod schema (fixes Bug B).
2. Recompute **tax/shipping/total server-side** from the cart + rules (fixes Bug A) — the LLM never supplies them.
3. `interrupt()` confirmation summary (items, server-computed total, full address).
4. On confirm → create the Stripe Session + `PendingCheckout` → return the **Stripe Hosted Checkout URL** as an SSE link the user clicks. The agent never sees card data — the PCI boundary holds for free.
5. The signed webhook creates the paid `Order` exactly as today.

**Doc change required:** rewrite the `place_order` description to "creates a `PendingCheckout` + Stripe session; the signed webhook creates the paid `Order`." Drop the "Pending/Unpaid order created first" language. The two-field state model survives, but note `paymentStatus` effectively starts at `paid` for Stripe and `pending` only for the **COD path** (`paymentMethod: 'cod'`), which the current doc ignores — document it.

**✅ Done 2026-10-10 (roadmap step 2):** architecture.md §3–§4 and §6, tech-stack.md Layer 4, security.md §9–§10, observability.md Layer 4 and evals.md §2/§7 now describe the payment-first flow. COD turned out to have no flow at all — `cod` exists only in the `paymentMethod` enum — so the agent is **Stripe-only in v1** (§5) and the docs say so instead of documenting a COD path.

### Gap 2 — Schema drift (docs vs. model/validation)

| Drift | Decision | Why |
|---|---|---|
| Order field is `user`, not `userId` | **Doc wording only** — authz filter is `{ user: ctx.userId }`. Do **not** rename the DB field. | "userId never in a *tool schema*" principle is untouched by the DB field name; renaming breaks existing code. |
| Statuses lowercase (`pending`…) vs. doc's Capitalized (`Pending`…) | **Doc → lowercase** to match the Mongoose enum (`order.model.ts:72`). | The model is the source of truth; changing it breaks admin/dashboard code. |
| `shippingAddress` missing `state`/`apt`; no server-side validation | **Create a backend Zod `shippingSchema` mirroring the frontend's 6 fields and validate it** in the checkout path. **Decided 2026-10-10 — implemented:** add optional `apartment` and `state` fields everywhere at once: frontend schema, backend schema, the Order and PendingCheckout models, and the admin order edit (validation, service and modal). No migration; older orders simply lack the fields. | Delivers the "same schema, no drift" promise and closes Bug B in one move. |
| No `refunded` `paymentStatus` | **Add `refunded`** to the enum + `cancelledAt`/`refundedAt`/`refundId`. | Required by `cancel_order` (see Gap 6). |

**Reference — real schemas (as of 2026-10-10):**
- Frontend `shippingSchema` (`mern-frontend/src/features/orders/schemas/shipping-schema.ts`) and backend `shippingSchema` (`src/validations/shipping.schema.ts`): `fullName, address, apartment?, city, state?, postalCode, country, phone?`. Before 2026-10-10 there were 6 fields, with no `state` or `apartment`.
- Order model `IShippingAddress` (`order.model.ts`): the same 8 fields; the PendingCheckout schema matches.
- Order `paymentStatus` enum (`order.model.ts:31`): `pending | paid | failed` — **no `refunded`.**

### Gap 3 — Router as a separate Haiku pass (unproven)

**Divergence:** doc assumes a discrete Haiku 4.5 intent-classification + query-rewrite hop; this adds latency and a misroute failure mode.

**Decision:** build only the **narrow, justified** piece now — the history-aware **query rewrite** for `ask_store_knowledge` retrieval. **Defer the separate intent-classification router.** Let the agent model (now Sonnet 5.5) route via native tool-use first. Add the Haiku router only if the golden set shows it beats self-routing on **both** router-accuracy (≥0.95) **and** end-to-end task-completion/latency. Decision made by eval, not by diagram. *Docs updated 2026-10-10: the router is gone from architecture.md's diagram and flow, tech-stack.md, observability.md and evals.md (where router accuracy is now conditional).*

**Update (2026-10-10, spec 013):** the query rewrite is dropped too. The search query is the tool's `question` argument, which the agent model writes with the whole conversation in view, so a Haiku rewrite would add a call and a failure path for little gain. The tool's description asks for a self-contained question; follow-up goldens check it, and the rewrite comes back if recall suffers. Haiku now only writes the chunk context lines at ingestion.

### Gap 4 — Loop / step-budget thresholds unspecified

**Divergence:** "loop detection" and "step budget exceeded" trigger Opus escalation and an eval gate, but no concrete `N` is given — the number is load-bearing for cost and the escalation-precision ≥0.9 metric.

**Decision:** pin concrete, tunable config constants and emit a reason enum:
- **Step budget:** 8 tool calls/turn (typical turn = 1–3; 8 is headroom).
- **Loop:** same `(tool name + normalized args)` seen on a 2nd identical repeat → stuck.
- **Repeated error:** same tool errors twice consecutively → stuck.
- On any trigger → escalate to Opus **once**, same budget. Opus trips again → offer `submit_support_request`.
- Emit `reason: loop | step_budget | repeated_tool_error` — this is what the escalation-precision eval and `observability.md` §2 assert against.

### Gap 5 — Idempotency key provenance

**Divergence:** `place_order` relies on an idempotency key but the doc doesn't say who generates it; a client/LLM-supplied key is a soft guarantee.

**Decision:** server-derived, **never** in the tool schema.
- Stripe path: already solved (server-generated session id).
- `place_order`: before creating a new session, **check for an existing non-expired `PendingCheckout` for `{ user, cartHash }`** (`cartHash` = sorted `productId:qty` + address hash). If found, return its URL instead of creating a second session. No idempotency argument in the LLM tool schema — consistent with "fields the LLM must never control aren't in the schema" (`security.md` §7). *Docs updated 2026-10-10: "idempotency key" is replaced by this checkout-reuse guard in architecture.md, tech-stack.md, security.md §10, observability.md and evals.md.*

### Gap 6 — `cancel_order` (the one genuinely-new capability)

The site UI shows `cancelled` but has no customer cancel action; the agent adds it.

**Decision:**
- Add `paymentStatus: 'refunded'` (+ `cancelledAt`, `refundedAt`, `refundId`) — see Gap 2.
- Atomic ownership + state check in one query:
  ```ts
  Order.findOneAndUpdate(
    { _id: orderId, user: ctx.userId, status: { $in: ['pending', 'processing'] } },
    { status: 'cancelled', cancelledAt: new Date() },
    { new: true }
  )
  ```
  A guessed `orderId`, another user's order, or a `shipped`/`delivered` order all return nothing.
- If the order was `paid`, the **server** issues `stripe.refunds.create` off the stored `stripeSessionId` → payment_intent, then sets `paymentStatus: 'refunded'`. **No refund tool, no refund-amount argument** for the LLM.
- Confirm-required (`interrupt()`) — irreversible + money.

---

## 3. Note on DeepEval

DeepEval-TS is beta; **we keep it** (expected to stabilize). The deterministic safety hard gates (confirmation-before-write, authz isolation, the duplicate-checkout guard, PII non-leak) should still be implemented as plain assertions that do not depend on the beta judge API; DeepEval is used for the genuinely subjective G-Eval rubrics (faithfulness, injection-resistance, scope adherence).

---

## 4. Suggested sequencing

1. ✅ **Bugs first** — server-side `tax`/`shipping` (Bug A) + shared `shippingSchema` server-side validation (Bug B). Live defects; unblock Gaps 1 & 2. *Done and committed 2026-10-10.*
2. ✅ **Doc reconciliation pass** — payment language, field names, statuses, COD path. *Done 2026-10-10:* payment-first `place_order` with the checkout-reuse guard (Gaps 1, 5); lowercase statuses and the `user` field (Gap 2); Stripe-only, no COD (§5); no separate router (Gap 3); Mongo product search in v1, Typesense deferred; models moved to Claude Sonnet 5.5 / Haiku 5.5 / Opus 5.5, with their API rules (effort instead of thinking budgets, no forced tool calls, append-only history, refusal handling) in tech-stack.md Layer 3; Gap 18's items.
3. **`cancel_order` + `refunded` enum** (Gap 6 + Gap 2 enum change), plus the stock-deduction fix (follow-ups §4) and a `/dashboard` cancel button sharing the agent's service. *Next.*
4. **Agent layer** — tool closures over `ctx.userId`, step/loop config (Gap 4), no query rewrite or router (Gap 3, spec 013). Separate router deferred behind an eval. Broken into milestones M1–M7 in [`phases.md`](./phases.md).

---

## 5. Open decisions (need product/owner call)

- **Address fields:** ✅ decided 2026-10-10 — add optional `apartment` and `state`; implemented. (Gap 2)
- **COD in the agent flow:** ✅ decided 2026-10-10 — the agent is Stripe-only in v1. No COD flow exists in the code (`cod` is only an enum value), so there is nothing to wrap. (Gap 1)
- **Tax/shipping rules:** ✅ interim rule in place — $0 tax and free shipping (`computeOrderPricing` in `pricing.service.ts`), now also stated on the site and in `mern-backend/knowledge/`. Change the rule there if the store introduces real tax or shipping; the owner is asked to confirm $0 tax is intended. (Bug A / Gap 1)

*Added 2026-10-09 — see §6:*
- **Product data:** ✅ decided 2026-10-10 — trim the tools to the fields that exist; reviews/specs/sale price only as a deliberate later feature. (Gap 7)
- **Support path:** ✅ decided 2026-10-10 — a backend endpoint that forwards to Make.com; implemented. (Gap 9)
- **Credential changes:** ✅ decided 2026-10-10 — make them work: change password and change email on Edit Profile, plus a working forgot-password; implemented. (Gap 10)
- **`upload_avatar` in v1:** ✅ decided 2026-10-10 — keep it. Upload limits are in place now; the upload-ID endpoint ships with the chat UI (M3). (Gap 11)
- **Store policies:** ✅ decided 2026-10-10 — drafts in `mern-backend/knowledge/`, written only from what the site and code already state; the owner fills in the `TODO(owner)` items listed in its README. (Gap 12)
- **Guests:** ✅ decided 2026-10-10 — the agent requires login in v1. (Gap 16)

---

## 6. Additional gaps found 2026-10-09 — not yet decided

> Found during a read-only pass over every file in both repos, after Bugs A/B were fixed. Unlike §1–§2, most of this isn't agreed yet: gaps marked **Proposed** await an owner decision (the questions are listed at the end of §5). **Gaps 7–17 were decided on 2026-10-10** (with Gap 2's address question from §2); Gap 18 is the checklist for the step-2 doc pass. Code bugs from the same pass are in [`follow-ups.md`](./follow-ups.md) §4–§12. Refs: `.ts` names are backend (`mern-backend/src/`); `fe/…` paths are frontend (`mern-frontend/src/`).
>
> **Progress check:**
> - §4 step 1 is implemented — Bug A via `pricing.service.ts`, Bug B via `shipping.schema.ts` + `validateBody` in `order.routes.ts`, both unit-tested — and committed on the `feature/shopping-agent` branch (2026-10-10). The line references in §0–§1 predate these fixes.
> - Step 2 is done (2026-10-10, see §4); steps 3–4 haven't started, and there's no agent code in either repo.
> - §5 status: tax/shipping has an interim answer ($0 tax, free shipping in `pricing.service.ts`), now stated on the site too (Gap 12); the address gained optional `apartment` and `state` fields (Gap 2); there is no COD flow at all (`cod` exists only in the `paymentMethod` enum).

### Gap 7 — Product data is thinner than the tool contract

**Divergence:** `get_product_details` (architecture.md §4) and customer-actions.md §2 promise materials, dimensions/specs, rating + review count, discount %, and review text. The Product schema stores only name, description, price, images, stock, category and brand (`product.model.ts:17`); `IProduct` declares `salePrice`/`sku`, but the schema never defines them. The frontend's `originalPrice`/`rating`/`reviews` (`fe/…/products/types/index.ts:22`) are never returned, so stars, review counts and "Sale" badges always render empty. With no reviews, the "injection via reviews" threat (security.md §5) and red-team cases 1, 11 and 12 (evals.md §7) can only target product name/description — which only admins write.

**Decision (2026-10-10):** trim the tool contract to the fields that exist (related products = same category, as the UI does). Reviews/specs/sale price come only as a deliberate feature (model + admin form + UI together). Descriptions stay wrapped as untrusted content regardless. Updated to match: architecture.md §4, evals.md §2/§7/§8, security.md §5. Gaps 8 and 13 (also decided 2026-10-10) carry this through to the sort options and customer-actions.md.

### Gap 8 — Sort options

**Divergence:** `search_products` and customer-actions.md include a rating/popularity sort, but there's no rating data and the UI offers only newest and the two price sorts (`fe/…/products-slice.ts:7`). On the backend, `best_selling` silently returns newest (`product.service.ts:152`), and `relevance` plus a search term crashes (follow-ups §6).

**Decision (2026-10-10):** the tool's sort enum is `newest | price_asc | price_desc`, mapped onto the backend's `newest | price_low | price_high`; `relevance` is added if Typesense is (v1 searches with Mongo; Typesense only if evals show the need). Recorded in architecture.md §4. The REST API's crashing `relevance` and silent `best_selling` options are unchanged — removing them is part of follow-ups §6.

### Gap 9 — `submit_support_request` has no backend

**Divergence:** architecture.md sends it to a "Human support inbox (/contact queue)". No such endpoint or queue exists: `/contact` posts from the browser straight to a Make.com webhook (`fe/…/contact.tsx:27`), has no `subject` field (`fe/…/contact-schema.tsx`), and name/email are whatever the user types. The webhook URL ships in the client bundle, so anyone can post to it directly.

**Decision (2026-10-10) — implemented:** `POST /api/v1/support` (`support.routes.ts`) validates `subject` + `message` (`support.schema.ts`) and forwards to the Make.com hook server-side via `SUPPORT_WEBHOOK_URL` (`support.service.ts`); the agent's tool will call that same service with `source: 'agent'`. One refinement to the proposal: auth is *optional*, not required, so guests can still use `/contact` — a signed-in sender's name/email always come from the session (any in the body are stripped), while guests must supply both. `/contact` now posts there with a new `subject` field (`fe/…/contact.tsx`), and the webhook URL is gone from the client. Covered by `support.schema.test.ts` and `support.routes.test.ts`, plus a browser check of the guest flow against a fake webhook.

**Still to do (owner):** set `SUPPORT_WEBHOOK_URL` in the backend's `.env.development` and in Vercel — until then the endpoint answers 503; map the new `subject` (and `userId`/`source`) fields in the Make.com scenario; regenerate the webhook URL in Make.com, since the old one stays public in git history and deployed bundles.

### Gap 10 — Credential changes have no working destination

**Divergence:** security.md §7 and architecture.md §4 send email/password changes to `/profile/edit` "with re-authentication". The backend silently ignores that page's email/password fields, there's no re-authentication, and the forgot-password page is a static stub (follow-ups §8). The agent's refusal would point users at a flow that doesn't work.

**Decision (2026-10-10) — implemented:** make the UI path work, then point the agent's refusal at it.
- **Backend** (`auth.routes.ts`, `auth.service.ts`):
  - `PATCH /auth/password` requires the current password, revokes every other session, and returns fresh tokens for this device.
  - `POST /auth/email-change` requires the current password, then emails a 6-digit code to the new address. The code is stored hashed and expires in 5 minutes.
  - `POST /auth/email-change/verify` allows 5 attempts and re-checks that the address is still free before switching.
  - One strong-password rule now covers register, reset and change.
  - Wrong-password and bad-code errors return 400 through `CredentialError` instead of the global 500.
  - Sign-up and reset codes were hardened at the same time (follow-ups §5), and every credential route is rate-limited (follow-ups §14).
- **Frontend:** the profile form saves only the name and avatar. Edit Profile gains Change Email and Change Password cards, and `/forgot-password` is a working two-step flow.
- **Agent:** "change my password/email" is refused with a pointer to Edit Profile (or forgot-password). Updated to match: security.md §7, architecture.md §4 and its parity paragraph, the refusal assertion in evals.md, and customer-actions.md §6.
- **Tests:** `auth.service.test.ts`, an HTTP run of the real auth router against in-memory models, and a browser check of all three flows with the outgoing mail captured.

### Gap 11 — `upload_avatar` assumes an upload flow that doesn't exist

**Divergence:** the docs assume the chat UI uploads the image, the server validates MIME + size and returns an opaque `uploadId`, and the agent passes only that id. Today the image goes straight into the multipart `PATCH /auth/profile` (`auth.controller.ts:227`), there's no `uploadId` concept, and uploads have no size/type limits (follow-ups §9).

**Decision (2026-10-10):** keep `upload_avatar`, and build its upload flow with the chat UI (M3). The prerequisite is already done (follow-ups §9). An avatar is now one JPEG, PNG, GIF or WEBP image of up to 2 MB, and product images are up to ten JPEG, PNG or WEBP images of up to 5 MB each. Anything else gets a 400.

**Design for M3:**
- `POST /api/v1/uploads/avatar` requires sign-in and applies the same limits (`uploadSingleFile`). It stores the image as a `PendingUpload` (`user`, `kind: 'avatar'`, `data`, `mimeType`, `size`) that expires after an hour, like `PendingCheckout`, and returns `{ uploadId }`.
- `applyAvatarUpload(userId, uploadId)` loads the upload by `{ _id: uploadId, user: userId }`, so another user's id finds nothing. It passes the image to the existing `updateUserProfile`, then deletes the upload.
- `upload_avatar(uploadId)` is confirm-gated and wraps `applyAvatarUpload`. The chat UI posts the attachment and sends only the `uploadId` with the message, so the agent never sees file bytes.

Updated to match: architecture.md §4 (the `upload_avatar` row), security.md §9 and tech-stack.md (the Uploads row).

### Gap 12 — `ask_store_knowledge` has no corpus, and the site copy contradicts itself

**Divergence:** the RAG pipeline ingests "FAQ · shipping · returns · policies · /about page"; none of those documents exist. The only policy-like text is marketing copy, and it disagrees with itself:
- "You can return any product within 30 days" (`fe/…/benefits-section.tsx:13`) is the only returns statement anywhere.
- Support is "available 24/7" (`fe/…/benefits-section.tsx:19`) vs "Mon – Fri, 9am – 6pm EST" (`fe/…/contact-form-wrapper.tsx:8`).
- The footer's phone/address (`fe/…/footer.tsx:65`) differ from the contact page's (`fe/…/contact-form-wrapper.tsx:5`).
- "Flexible payment options" (`fe/…/benefits-section.tsx:7`), but only Stripe card checkout exists.
- Cart and checkout say tax/shipping are calculated later, but the v1 rule is $0 / free (follow-ups §12).
- The footer's FAQ, "Shipping & Returns" and "Size Guide" links all go to `/about`, which covers none of them.

**Proposed:** write the canonical knowledge docs first (shipping, returns/refunds, payment methods, support hours/contact, FAQ) and correct the site copy to match. They're both the ingestion source and the ground truth for the faithfulness/recall goldens; without them, a "faithful" answer can still repeat a contradiction.

**Decision (2026-10-10) — drafted:** the knowledge docs live in `mern-backend/knowledge/`, versioned with the code that will index them.
- `README.md` sets the rules:
  - One question-style `##` heading per chunk.
  - Only facts the site or code already states, each with a source comment.
  - Unknowns are written as `TODO(owner)`, and ingestion skips those chunks.
- Seven topic files: shipping, returns, payments, orders, account, contact-and-support and about.
- The README's owner checklist lists what's still open: shipping regions and times, tracking, return conditions and refunds, cancellation, the phone number and the studio address.

The site copy now matches the docs. Contact details come from one place, `fe/…/shared/config/store.ts`, which the contact page, footer and home page all use.
- **Benefits section:** "Pay securely by card through Stripe" replaces "flexible payment options", and the contact page's hours replace "24/7". The 30-day return line stays, since it's the only returns statement; the owner is asked to confirm it.
- **Footer:** shows the contact page's email, phone and address. "Our Story" → `/about` replaces the dead FAQ, "Shipping & Returns" and "Size Guide" links.
- **Cart and checkout:** free shipping, no tax added (follow-ups §12).
- **Order email:** the promise to notify customers on dispatch is gone, since no such email exists. The © year is now the current year.

Also updated: evals.md §15's example golden uses a fact from these docs, and architecture.md §2 names `mern-backend/knowledge/` as the ingestion source.

### Gap 13 — `customer-actions.md` describes UI that doesn't exist

**Divergence:** listed there but not built:
- State/Province and Apartment/Suite address fields (Gap 2 open decision).
- Rating/popularity sort (Gap 8); image zoom; materials/specs (Gap 7).
- Estimated tax/shipping on `/cart`, and a per-item "remove" there (remove exists only on product cards and the detail page). "Clear Cart" has no confirmation (`fe/…/cart-page.tsx:54` fires immediately).
- Order ID, delivery timeline and payment status on `/order/success` (it shows the Stripe session id).
- Role and account status on `/profile`; a working email/password change and forgot-password (Gap 10).
- Shipping guarantees and policies on `/about` (Gap 12). (The `/contact` subject field was added with Gap 9.)

**Decision (2026-10-10) — done:** customer-actions.md now describes the UI as built, checked against the code (§1–§7), and everything missing is listed in its §8 with a status. Items are marked planned only where a decision already says so (e.g. `cancel_order`); the rest are "not built", to be built only if the product wants them. architecture.md's parity paragraph now points at §1–§7 and also excludes account access (sign-up, sign-in), which the agent doesn't do.

**Update (2026-10-10):** the address fields (Gap 2) and credential flows (Gap 10) are now built, and the cart's tax/shipping note was corrected (Gap 12). customer-actions.md §3, §4, §6 and §8 were updated to match.

### Gap 14 — Streaming transport and hosting

**Divergence:** tech-stack.md Layer 1 specifies native `EventSource`, which is GET-only and can't send an `Authorization` header — but auth here is a Bearer token from `localStorage` (`fe/…/api.ts:6`), with no auth cookie. Separately, the backend runs as a Vercel serverless function (`api/index.ts`) behind the frontend's `/api` rewrite (`mern-frontend/vercel.json`), and the frontend has no token refresh yet (follow-ups §10).

**Decision (2026-10-10):** stream with `fetch()` + `ReadableStream` (POST body + Bearer header) instead of `EventSource`, keeping the SSE wire format; tech-stack.md Layer 1 updated. Every request is stateless: `interrupt()`/resume goes through the Mongo checkpointer, never in-process state.

**Pre-build checks** (before the chat endpoint is written):
1. Deploy a minimal streaming endpoint to Vercel and confirm chunks arrive incrementally through the frontend's `/api` rewrite, not all at once.
2. Confirm the plan's maximum function duration covers a worst-case turn, including an Opus escalation — `vercel.json` sets no `maxDuration`, so the plan default applies.
3. Give the stream the 401 → refresh handling from follow-ups §10, or long sessions will fail mid-chat.

### Gap 15 — Services are bound to the Express request

**Divergence:** tools are meant to close over `ctx.userId` (security.md §3), but the cart services read `req.user`/`req.session` (`cart.service.ts:95`) — the webhook already fakes a `req` to reuse them (`order.service.ts:139`). The HTTP validation also differs from the tool contract: `PATCH /cart/items/:productId` requires quantity ≥ 1 (`cart.validation.ts:13`) while `update_cart_item(…, 0)` means remove, and add-to-cart has no upper bound (docs: 1–99).

**Decision (2026-10-10) — implemented:** the cart services are split. `cart.service.ts` holds signed-in carts with `(userId, …)` signatures — what the tools will call — and the new `guest-cart.service.ts` holds session carts, which take `req.session` rather than `req`. The controllers pick between them on `req.user`, so no service takes an Express request any more: the webhook's fake `req` is gone, and `createCheckoutSession` now takes `(userId, shippingAddress)`, so `place_order` can wrap it directly (Gap 1). Cart bodies are validated with zod in `cart.schema.ts` (quantity 1–99, default 1), which the tools will reuse, and the frontend's quantity pickers now cap at 99 to match. Covered by `cart.service.test.ts` (both cart families against in-memory models, including quantity 0 removing an item and the guest → account merge on sign-in) and `cart.schema.test.ts`, plus a DB-free HTTP run of the real cart router. The old service's session-dumping `console.log`s were dropped in the move (follow-ups §11).

### Gap 16 — Guests

**Divergence:** the store supports guest carts (`optionalAuthMiddleware` + session cart), but every agent doc assumes an authenticated `userId`.

**Decision (2026-10-10):** require login for the agent in v1 — it matches the docs and keeps identity binding simple. Guests get a sign-in prompt instead of the chat (recorded in architecture.md §3); if guests are wanted later, give them read-only tools.

### Gap 17 — Rate limits and logging vs. security/observability

**Divergence:** security.md §10 assumes per-user limits on LLM calls and writes. The existing limiter is per-IP (`rate.lim.ts:19`), covers only login, resend-otp and refresh-token, and is off in development (`rate.limiter.ts:12`). observability.md requires no PII in logs; current logs persist user emails for 30 days (follow-ups §11).

**Decision (2026-10-10):** as proposed — the agent gets its own per-user limiter keyed on `ctx.userId`, with separate budgets for LLM turns, writes and Opus escalations, built on the same `rate-limiter-flexible` + Mongo store and on in every environment; security.md §10 updated. The budget numbers are set when the agent is built, alongside Gap 4's step budget. One constraint surfaced while deciding: today's per-IP limiter is initialized only in `src/index.ts`, never in the Vercel entry point `api/index.ts`, so it is off in production as well as development (follow-ups §14). The agent's limiter must be created lazily on first use, or from both entry points.

### Gap 18 — Extra items for the step-2 doc pass

Beyond the changes already listed in Gaps 1–2:
- After payment the webhook leaves `status: 'pending'` (`order.service.ts:124`); the docs say it moves to `Processing`.
- Payment-first means there are no `Pending/Unpaid` orders. observability.md's "stale Pending/Unpaid orders" signal becomes "expired `PendingCheckout`s / abandoned Stripe sessions", and evals.md's `place_order` assertion becomes "a `PendingCheckout` + Stripe URL is returned; no `Order` exists until the webhook".
- The backend `.env.example` still lists Gemini and Redis chat-memory settings; the design is Claude + the Mongo checkpointer.

**✅ Doc items done 2026-10-10:** the webhook's `status: 'pending'` is now what the docs say (architecture.md §3–§4); "stale Pending/Unpaid orders" became expired `PendingCheckout`s / paid sessions with no order (observability.md Layer 4 and SLOs); the `place_order` eval asserts a `PendingCheckout` + link and no `Order` before the webhook (evals.md §2). **Still open:** rewriting `.env.example` (a code change, scheduled before launch together with `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `LANGSMITH_*` and `SUPPORT_WEBHOOK_URL`).
