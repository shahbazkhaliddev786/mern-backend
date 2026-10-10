# Orders

## Do I need an account to order?

You can browse and add items to your cart without an account, but you need to sign in to check out. Anything already in your cart is kept when you sign in.

<!-- source: src/routes/order.routes.ts (POST /orders/checkout requires sign-in); src/services/guest-cart.service.ts (mergeGuestCartOnLogin) -->

## How do I place an order?

Add items to your cart, open the cart and choose "Proceed to Checkout". Enter your shipping address, then choose "Proceed to Payment" to pay on Stripe's secure page. After paying you see a confirmation page, and an order confirmation is emailed to your account's email address.

<!-- source: mern-frontend cart, checkout and order-success pages; src/services/order.service.ts -->

## Will I get an order confirmation?

Yes. Once your payment goes through, we email an order confirmation to your account's email address with your order number, the items, the total and your shipping address.

<!-- source: src/utils/order.confirmation.email.ts -->

## How do I check my order's status?

Sign in and open My Orders (the Dashboard link in your account menu). Each order shows its status: pending (paid and received, not yet being prepared), processing, shipped, delivered or cancelled.

<!-- source: mern-frontend user-dashboard-page.tsx; Order status values in src/models/order.model.ts -->

## What is my order number?

Your order number is the 8-character code after the # sign, for example #1A2B3C4D. It appears on My Orders and in your confirmation email. Mention it when you contact us about an order.

<!-- source: mern-frontend order-card.tsx and src/utils/order.confirmation.email.ts (last 8 characters of the order ID, uppercase) -->

## What happens if my payment fails?

No order is created and you aren't charged. Your cart stays as it was, so you can try again from the cart.

<!-- source: src/services/order.service.ts (orders are created only after Stripe confirms payment) -->

## Can I cancel or change my order?

TODO(owner): your cancellation policy. (Orders can't be cancelled or changed from the site yet; self-service cancellation of pending and processing orders is planned.)
