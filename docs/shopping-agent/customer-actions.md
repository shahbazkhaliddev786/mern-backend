# Customer Operations Guide

This document lists the customer-facing operations the Aljo Store web platform actually supports: catalog discovery, product inspection, cart & checkout, order tracking, account & profile management, and customer support.

> **Scope:** §1–§7 describe the UI as built, verified against the code on 2026-10-10 ([`reconciliation.md`](./reconciliation.md) Gap 13). Anything not built is listed in §8 with its status. [`architecture.md`](./architecture.md)'s feature-parity claim is measured against §1–§7 only.

---

## 1. Catalog Browsing, Search & Filtering (`/products`)

* **Keyword Search:** Search product names and descriptions; input is debounced.
* **Category Filtering:** Select one or more categories from a collapsible checkbox list.
* **Brand Filtering:** Select one or more brands from a collapsible checkbox list.
* **Price Range:** Set a minimum and/or maximum price; input is debounced.
* **Sorting:** Newest (default), Price: Low to High, or Price: High to Low.
* **Clear All:** Reset the search, category, brand, price and sort selections in one click.
* **Pagination:** Results come 9 per page.
* **Mobile Filters:** On small screens, the filters open in a slide-over panel.
* **Quick Add to Cart:** Add one unit straight from a product card; once the product is in the cart, the card's button removes it instead.

---

## 2. Product Detail Inspection (`/products/:id`)

* **Image Gallery:** A main image, plus a thumbnail strip to switch images when the product has more than one.
* **Stock & Price:**
  * "In Stock (N available)" or "Out of Stock".
  * The price.
  * A star rating and review count are displayed but always read 0 — products have no rating or review data ([`reconciliation.md`](./reconciliation.md) Gap 7).
* **Product Information:** Category, brand, name and description.
* **Quantity Selection:** Increment or decrement the quantity, bounded by available stock (shown while the product is in stock and not yet in the cart).
* **Cart Interaction:** Add the selected quantity to the cart. If the product is already in the cart, remove it from here; quantities are changed on `/cart`.
* **Related Products:** "You Might Also Like" shows up to four other products — same category first — linking to their pages.

---

## 3. Shopping Cart Management (`/cart`)

* **Cart Review:** Each item shows its image, category, name, unit price, quantity and line total.
* **Quantity Adjustments:** Change an item's quantity (from 1 up to available stock) with the +/− buttons or by typing; totals recalculate immediately.
* **Clear Cart:** Remove every item in one click (there is no confirmation step).
* **Order Summary:** The subtotal, with a note that shipping is free and no tax is added.
* **Navigation:** Continue shopping, or proceed to checkout.
* **Guest Carts:** The cart works without an account and is merged into the user's cart when they sign in.

---

## 4. Checkout & Order Placement (`/checkout` & `/order/success`)

* **Shipping Address:** Full name, street address, an optional apartment/suite, city, an optional state/province, postal code, country, and an optional phone number — validated in the browser and again on the server.
* **Order Review:** An itemized summary with the subtotal, free shipping, $0.00 tax and the total.
* **Payment:** "Proceed to Payment" redirects to Stripe's hosted checkout to pay by card. Paying requires being signed in.
* **Order Confirmation:**
  * `/order/success` confirms the purchase, shows the Stripe session ID as the order reference, and empties the cart.
  * The order itself is created once Stripe confirms the payment, and a confirmation email (order number, items and totals) is sent to the customer.

---

## 5. Customer Dashboard & Order Tracking (`/dashboard`)

Signed-in customers can:

* **View Order History:** All their orders, newest first.
* **Track Status:** Each order shows its fulfillment status — *Pending*, *Processing*, *Shipped*, *Delivered* or *Cancelled*.
* **Review Each Order:** Order number, date, item images and names, quantities, unit prices, line totals and the total paid.
* **Return to the Catalog:** With no orders yet, "Explore Products" links back to the catalog.

---

## 6. Account & Profile (`/signup`, `/login`, `/profile`, `/profile/edit`)

* **Sign Up & Verify:** Create an account (name, email, password, optional profile picture), then confirm it with a 6-digit code sent by email; the code can be resent.
* **Sign In / Sign Out:** Sign in with email and password; sign out from the profile menu. Signing in to an account that was never verified emails a fresh code and opens the verification page. The code can be typed or pasted.
* **Forgot Password (`/forgot-password`):** Request a 6-digit code by email, then enter it with a new password. The code can be resent, and a reset signs the account out on every device.
* **View Profile (`/profile`):** Name, email address and profile picture.
* **Edit Profile (`/profile/edit`):**
  * Change the display name.
  * Upload a new profile picture (JPEG, PNG, GIF or WEBP, up to 2 MB), with a preview before saving.
  * **Change Email:** Enter the new address and the current password. A 6-digit code goes to the new address, and the email changes once that code is entered.
  * **Change Password:** Enter the current password and a new one (with confirmation). Other devices are signed out, and this one stays signed in.

---

## 7. Customer Support & Store Information (`/contact` & `/about`)

* **Contact Form (`/contact`):** Send a support request, product inquiry or feedback with a subject and message. Guests also give their name and email; signed-in users write as their account. The page also lists the store's email, phone, studio address and opening hours; the footer shows the same email, phone and address.
* **About the Store (`/about`):** The store's story, craft principles, and sourcing and packaging commitments.

---

## 8. Not in the UI yet

Listed so nothing above is mistaken for a promise. Status as of 2026-10-10 (gap numbers refer to [`reconciliation.md`](./reconciliation.md) §2/§6, section numbers to [`follow-ups.md`](./follow-ups.md)):

| Item | Status |
|---|---|
| Ratings & reviews; rating/popularity sort; sale prices & discounts; materials, dimensions & specs | Not planned for v1 (Gaps 7, 8) |
| Shipping, returns and other store policies on the site | Drafted as facts in `mern-backend/knowledge/`. Shipping regions and times, return conditions, refunds and cancellation still need the owner's answers before any page states them (Gap 12) |
| Customer order cancellation | Planned for both a `/dashboard` button and the agent's `cancel_order`, through one service (roadmap step 3; Gap 6) |
| Image zoom; per-item remove on `/cart`; a confirmation before clearing the cart; order ID, payment status and delivery timeline on `/order/success`; role and account status on `/profile` | Not built — build only if the product wants them (Gap 13) |
| Newsletter sign-up (home page) | Form only: nothing is stored or sent, and its confirmation never appears (follow-ups §13) |
