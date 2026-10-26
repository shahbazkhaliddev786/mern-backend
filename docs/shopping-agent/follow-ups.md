# AI Shopping Assistant — Follow-ups (tech debt discovered during implementation)

> Code-cleanup / hardening items found while doing other work. The **feature roadmap** (agent layer, `cancel_order`, `refunded` enum, router) lives in [`reconciliation.md`](./reconciliation.md) §4 — this file is only the smaller tech-debt list.

---

## 1. Harden `admin-order.service.ts` money computation — ✅ DONE (2026-10-07)

**Found:** while fixing Bug A (customer checkout money is now server-side — see [`reconciliation.md`](./reconciliation.md) §1).

`admin-order.service.ts` computed `total = subtotal + tax + shipping` inline from admin-supplied `tax`/`shipping`. Admin is a trusted role (and the admin UI's order-detail modal genuinely edits tax/shipping), so the override is a real feature to keep — but the formula was duplicated and unrounded.

**Fixed:** the order-total formula + rounding now live in one place — `computeOrderTotal(subtotal, tax, shipping)` in `src/services/pricing.service.ts`, which `computeOrderPricing` (customer/agent path) also delegates to. `adminUpdateOrderDetailsService` routes through it: subtotal is still recomputed from server-resolved line items, the admin tax/shipping **override is kept** (already validated non-negative in `adminUpdateOrderDetailsValidation`), and the edit is now **audit-logged** (`ADMIN_ORDER_DETAILS_UPDATED`, before/after money). Covered by unit tests for `computeOrderTotal`.

---

## 2. Remove duplicate Mongoose schema indexes — ✅ DONE (2026-10-07)

The dev server logged duplicate-index warnings on boot for `{"user":1}` and `{"stripeSessionId":1}` — each index was declared twice (field-level `unique: true` **and** an explicit `schema.index()` call).

**Fixed:** dropped the redundant `schema.index()` calls, keeping the field-level `unique` constraint — `OrderSchema.index({ stripeSessionId: 1 })` removed from `order.model.ts`; `CartSchema.index({ user: 1 })` removed from `cart.model.ts`. Verified: server boots clean with no duplicate-index warnings. The genuinely distinct indexes (`{user:1, createdAt:-1}`, `{status:1}`) were left intact.

---

## 3. Admin order edit fails on orders with an incomplete `shippingAddress` — ✅ DONE (2026-10-07)

**Found:** while live-testing item 1. `adminUpdateOrderDetailsService` (`admin-order.service.ts`) ended with `order.save()`, which re-validates the **entire** Mongoose document. Orders whose `shippingAddress` was missing required fields (`fullName`/`address`/`city`) therefore **could not be edited at all** — even a tax/shipping-only change returned `500 Order validation failed: shippingAddress.city is required…`. Such orders exist in the DB today (older/partial records).

**Fixed:** changed the save to `order.save({ validateModifiedOnly: true })` so only the paths the admin actually changed are validated; pre-existing invalid fields no longer block an unrelated edit. Verified live — a tax/shipping edit on an order with `shippingAddress: null` now returns 200 with the correctly recomputed total (previously 500).

---

> **Items 4–12** were found on 2026-10-09 during a read-only pass over both codebases (5, 8 and 9 fixed on 2026-10-10). Agent-design gaps from the same pass are in [`reconciliation.md`](./reconciliation.md) §6. Refs: `.ts` names are backend (`mern-backend/src/`); `fe/…` paths are frontend (`mern-frontend/src/`).

---

## 4. Stock deduction misses the normal fulfillment path — OPEN

`updateOrderStatus` (`order.service.ts:170`) decrements stock only when an order jumps **directly** from `pending` to `shipped`/`delivered`:
- The usual `pending → processing → shipped` path never decrements stock.
- `pending → shipped → pending → shipped` decrements twice — nothing records that stock was already taken.
- Cancelling never restores stock, and nothing reserves stock at payment, so overselling is possible.
- If one item is short, the `bulkWrite` has already decremented the others when the error is thrown.

**Suggested fix:** deduct once at a single well-defined point (in the webhook when the paid `Order` is created, or on the first transition out of `pending`), record it on the order (e.g. `stockDeductedAt`), restore it on cancel, and run the update in a transaction. `cancel_order` (reconciliation Gap 6) needs the restore path anyway.

---

## 5. OTP brute-force protection doesn't work — ✅ DONE (2026-10-10)

- `attempts` is reset and checked (`auth.service.ts:51`, `:187`) but never incremented, and the lookup is `{ email, otp }`, so a wrong guess never even finds the record. The "Too many attempts" lockout is dead code.
- `/verify-otp`, `/forgot-password` and `/reset-password` have no rate limiter (`auth.routes.ts:34`, `:40–41`); the limiter is per-IP, off in development, and never initialized on Vercel at all (§14).
- Codes come from `Math.random()` (`auth.service.ts:38`).

**Suggested fix:** look up by email, increment `attempts` on every miss and delete the record at the limit, rate-limit all three routes, and generate codes with `crypto.randomInt`.

**Fixed:** codes come from `crypto.randomInt`. One helper, `consumeOtp` in `auth.service.ts`, now checks every sign-up and reset code: it looks the code up by email, rejects expired codes, counts each miss, and deletes the record once the code is used or after the 5th miss. A password reset also revokes every refresh token. `verify-otp`, `forgot-password` and `reset-password` are rate-limited, and the limiter now runs in production (§14). The reset email no longer says "Thanks for signing up": each code email has copy for its purpose (`email.ts`). Covered by `auth.service.test.ts` and an HTTP run of the real auth router against in-memory models.

---

## 6. Unvalidated search/filter input reaches regexes and casts — OPEN

`GET /api/v1/products` has no query validation (each case below verified against the installed Mongoose 9.0.2):
- `search` goes into `new RegExp(...)` unescaped (`product.service.ts:100`): `?search=(` → 500, and crafted patterns can make Mongo slow (ReDoS).
- `?sort=relevance&search=x` builds a sort Mongoose rejects ("Invalid sort() argument, must be array of arrays") → 500 (`product.service.ts:134`).
- An invalid `category`/`brand` id throws a `BSONError` → 500 (`:111`, `:119`).
- `page`/`limit` are unbounded.

The same raw-regex pattern is in the admin searches (`admin-order.service.ts:32`, `admin-cart.service.ts:18`, `admin-user.service.ts:24`) and the brand/category duplicate-name checks (`brand.service.ts:8`, `:50`; `category.service.ts:8`, `:50`).

**Suggested fix:** a zod schema for the product query (escape regex input, enum the sort, validate ids, cap `limit`) and one shared `escapeRegex` helper for the admin paths. The agent's `search_products` tool should reuse the same schema (reconciliation Gap 8).

---

## 7. Every error is returned as a 500 with its raw message — OPEN

`global-error.handler.ts:7` always responds 500 and echoes `err.message`, ignoring the `status` that `NotFoundError`/`UnauthorizedError` carry (`order.service.ts:14`). The frontend already works around this (`fe/…/auth-slice.ts:21`). Side effect: `GET /orders/:orderId` returns 403 for another user's order but 500 ("Order not found") for a nonexistent one, so order ids can be probed.

**Suggested fix:** honor `err.status` (default 500), map validation/cast errors to 400 and not-found to 404, and return a generic message for unexpected 500s. Scope the order lookup by owner (`{ _id, user }`) and return 404 in both cases — the same rule `get_order_status` follows.

---

## 8. `/profile/edit` silently drops email and password changes — ✅ DONE (2026-10-10)

The page sends `email` and `password` (`fe/…/profile.service.ts:43`), but `updateProfile` reads only `name` and the avatar file (`auth.controller.ts:227`). The user gets a success toast and nothing changes. The forgot-password page is a static stub (`fe/…/forgot-password.tsx`) even though `/forgot-password` and `/reset-password` exist, so there's currently no working password-change path in the UI.

**Suggested fix:** either remove the two fields, or implement them properly (email change with OTP re-verification, password change requiring the current password), and wire forgot-password to the existing endpoints. The agent docs route credential changes to this page (reconciliation Gap 10).

**Fixed (reconciliation Gap 10):** the profile form now saves only the name and avatar. Edit Profile has two new sections:
- **Change Password** calls `PATCH /auth/password`. It requires the current password and revokes every other session; this device receives fresh tokens.
- **Change Email** calls `POST /auth/email-change` with the current password, and a 6-digit code goes to the new address. `POST /auth/email-change/verify` makes the switch. The code is stored hashed and expires in 5 minutes, and 5 misses cancel the change.

`/forgot-password` is a two-step flow on the existing endpoints. All three were checked in the browser against an in-memory API with the outgoing mail captured.

---

## 9. Uploads have no size or type limits — ✅ DONE (2026-10-10)

`multer.middleware.ts:7` uses memory storage with no `limits` or `fileFilter`, for both avatars and product images. The edit page promises "up to 2MB" (`fe/…/edit-profile-page.tsx:110`) and the product form says the "server re-validates" (`fe/…/ProductFormModal.tsx:69`); neither is enforced server-side.

**Suggested fix:** `limits.fileSize` plus an image-MIME `fileFilter` on both upload middlewares. Prerequisite for `upload_avatar` (reconciliation Gap 11).

**Fixed:** `multer.middleware.ts` now enforces two sets of limits:
- Avatars: one file, up to 2 MB, JPEG, PNG, GIF or WEBP.
- Product images: up to 10 files, each up to 5 MB, JPEG, PNG or WEBP. This matches `ProductFormModal`.

Too large, too many, or the wrong type now gets a 400 with a message saying which, instead of a 500. The avatar inputs on sign-up and Edit Profile only offer those types. Covered by `multer.middleware.test.ts`, which sends real multipart requests. The type check trusts the declared MIME type; Cloudinary rejects bytes that aren't really an image. Sniffing the file's contents would be the next step if that ever matters.

---

## 10. Frontend session handling: no token refresh, client-only logout — OPEN

- **No refresh:** the refresh token is stored but never used — `apiFetch` has no 401 handling (`fe/…/api.ts`) and `isAuthenticated` comes from token presence (`fe/…/auth-slice.ts:74`). Once the access token expires (`1d` in `.env.example`), the UI still looks logged in, but `optionalAuthMiddleware` rejects the expired token (`auth.middleware.ts:64`), so the cart and every authenticated call fail with 401 until the user logs out and back in.
- **Logout is client-only** (`fe/…/header.tsx:86`, `fe/…/profile-menu.tsx:68`, `fe/…/AdminSidebar.tsx:15`): `/auth/logout` is never called, so the refresh token is never revoked, and the React Query cache isn't cleared (login only invalidates `['cart']`, `fe/…/login.tsx:33`). The next user on the same tab can see the previous user's cached profile (fresh for 5 min, `fe/…/useProfileQuery.ts:14`) and orders.

**Suggested fix:** a 401 interceptor that calls `/auth/refresh-token` once and retries (or logs out), and a logout that calls `/auth/logout` and `queryClient.clear()`. The chat stream needs the same refresh handling (reconciliation Gap 14).

---

## 11. PII in persisted logs — OPEN

User emails are logged on register, OTP resend/verify and forgot/reset password (`auth.controller.ts:73`, `:92`, `:117`, `:244`, `:259`), by the OTP mail (`email.ts:142`) and by the order confirmation (`order.confirmation.email.ts:104`), and persisted to the Mongo `application-logs` collection for 30 days (`logger.ts:119`). observability.md (Layer 5) requires no PII in logs. (The cart service's session-dumping `console.log`s were removed on 2026-10-10 by the reconciliation Gap 15 refactor.)

**Suggested fix:** log the user id (or a hash of the email) instead.

---

## 12. Checkout leftovers in the frontend — OPEN

- The checkout POST still sends `items`, `subtotal`, `tax`, `shipping` and `total` (`fe/…/orders.service.ts:4`, `fe/…/checkout-page.tsx:24`). The server now strips them; remove them so the client matches the contract.
- `/order/success` clears the cart client-side whenever the URL has a `session_id` (`fe/…/order-success-page.tsx:13`), duplicating the webhook, and shows the Stripe session id as the "Order Reference" (`:36`).
- `/checkout` isn't behind `ProtectedRoute` (`fe/router.tsx:74`), but `POST /orders/checkout` requires auth, so a guest fills in the form and then gets a 401.
- ✅ *Fixed 2026-10-10 (reconciliation Gap 12):* the cart and checkout said tax/shipping are calculated "at checkout" / "at next step", but the v1 rule is $0 tax and free shipping. The cart now says "Free shipping, no tax added", and the checkout summary shows Shipping: Free and Tax: $0.00.

---

## 13. sonner toasts never render (checkout errors, newsletter) — OPEN (found 2026-10-10)

`useCheckout` and the newsletter form call `toast` from `sonner` (`fe/…/useCheckout.ts:2`, `fe/…/newsletter-section.tsx:2`), but sonner's `<Toaster />` is never mounted — only react-toastify's `ToastContainer` is (`fe/main.tsx:21`). Checkout errors (e.g. the guest 401 in §12) and the newsletter confirmation never show. `/contact` had the same problem and was switched to react-toastify while implementing reconciliation Gap 9.

**Suggested fix:** switch both to react-toastify like the rest of the app, or mount sonner's `<Toaster />` once in `main.tsx`.

---

## 14. The per-IP rate limiter never runs in production — ✅ DONE (2026-10-10, one deploy check left)

`initRateLimiter` is called only from `src/index.ts:27`, the local/Docker entry point. The Vercel entry point (`api/index.ts`) never calls it, so `getRateLimiter()` returns `null` and `rateLimiterMiddleware` lets every request through — login, resend-OTP and refresh-token are unthrottled in production, compounding §5. (`initRateLimiter` also skips development on purpose.)

**Suggested fix:** create the limiter lazily on first use (or call `initRateLimiter` from `api/index.ts` after `connectDB()`), and add a test that the middleware starts rejecting after the configured number of requests. The agent's per-user limiter has the same constraint (reconciliation Gap 17).

**Fixed:** `getRateLimiter()` (`config/rate.limiter.ts`) creates the limiter on first use, so every entry point gets it, including Vercel's; `initRateLimiter` is gone. It is still off in development.

**Not done:**
- The rejection test. `RateLimiterMongo` needs a database, so it would need an in-memory limiter injected for tests.
- **Deploy check:** the limiter keys on `req.ip`, and `loaders/express.ts` sets `trust proxy` to 1. Behind the frontend's `/api` rewrite, confirm once that `req.ip` is the shopper's address and not a Vercel proxy's (log `req.ip` next to `x-forwarded-for` for one request). If every request shows the same address, all users share one 100-requests-per-minute bucket on the auth and support routes. Then adjust `trust proxy` or key on Vercel's `x-real-ip`.

---

## 15. Unverified accounts can't get back to email verification — ✅ DONE (2026-10-10)

`/verify-email` only works when sign-up navigates there with the email in router state (`fe/…/verify-email.tsx:13`); opened any other way, it redirects to `/signup`. If a new user leaves before entering the code:
- Signing in fails with "Please verify your email first" (`auth.service.ts`, `loginWithPassword`).
- Signing up again fails with "Email already registered".
- Nothing in the UI resends the code.

A password reset doesn't help either: it never marks the account verified.

**Suggested fix:** when sign-in fails for an unverified account, send a fresh code and route to `/verify-email` with the email. Also mark the account verified after a successful password reset, since entering an emailed code proves the same thing.

**Fixed:**
- **Sign-in:** the right password on an unverified account now emails a fresh code and answers 403 with `data.needsVerification` (`UnverifiedAccountError` in `auth.service.ts`); a wrong password sends nothing. The login page shows the message and opens `/verify-email` with the email.
- **Password reset:** a successful reset marks the account verified.
- **Pasted codes:** the verification boxes now accept a pasted or autofilled 6-digit code; before, only its last digit was kept.

Covered by three cases in `auth.service.test.ts` and two in the frontend `auth-slice.test.ts`, and checked in the browser (sign in → code page → paste the emailed code → verified).

---

## 16. Backend lint couldn't run — ✅ DONE (2026-10-10)

`eslint.config.mjs` imported `typescript-eslint`, which wasn't installed. It also called an undefined `testlint`, nested `files`/`extends` inside `languageOptions`, and misspelled `quotes`. **Fixed:** the config is rewritten on the frontend's pattern, the missing packages are installed, `npm run lint` is added, and the existing errors are fixed (quotes, `console` → the winston logger, unused imports, two dead `@ts-ignore`s). About 100 existing `any`s remain as warnings. The install needed `--legacy-peer-deps` because of an unrelated peer conflict: `deepeval` pins `@langchain/core` 1.1.31 while the agent packages need ≥ 1.2.14. **Update (spec 019):** that conflict also made a plain `npm ci` / `npm install` fail (as CI and Vercel run them) since the agent dependencies were added; a committed `.npmrc` (`legacy-peer-deps=true`) now applies the setting to every install. Remove it once a `deepeval` release accepts `@langchain/core` ≥ 1.2.

---

## 17. Smaller findings from the agent code review — OPEN (found 2026-10-27)

The review of the agent pull requests (spec 022) also found four low-risk items, deferred there:
- **Checkout reads more than it needs.** `createOrReuseCheckoutSession` reads the cart twice and looks up the `PendingCheckout` it just created. `place_order`'s address lookup loads the whole order history to use the newest one. Fix: pass the cart into `createCheckoutSession` and return the created id, and use `findOne().sort({ createdAt: -1 })`.
- **Chat image previews are never released (frontend).** `URL.createObjectURL` runs for every picked file, rejected ones included, and nothing revokes them. Fix: no preview for a rejected file, and revoke on remove, New chat and unmount.
- **The login-refresh code is copied three times (frontend).** `streamChat`, `uploadAvatar` and `sendFeedback` repeat the send → 401 → refresh → resend block and the error mapping. Fix: one `fetchWithRefresh` helper, reusing `shared/services/api.ts`'s token and message helpers.
- **A stray "Stopped" after a user switch (frontend).** If the signed-in user changes while a reply streams, the abort lands after the new user's chat loads and marks their last reply stopped.

---

_Items 1–3 resolved 2026-10-07; 5, 8, 9, 14, 15 and 16 resolved 2026-10-10; 4, 6, 7, 10–13 and 17 open. New tech-debt discoveries get appended here._
