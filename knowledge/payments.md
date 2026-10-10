# Payments

## What payment methods do you accept?

You pay by debit or credit card on Stripe's secure checkout page. Cash on delivery isn't available.

<!-- source: src/services/order.service.ts (Stripe Checkout, payment_method_types: ['card']); checkout page -->

## What currency are your prices in?

All prices are in US dollars (USD).

<!-- source: src/services/order.service.ts (currency: 'usd') -->

## Is it safe to pay on your site?

Yes. When you choose "Proceed to Payment", you're taken to Stripe's secure checkout page to enter your card details, so Aljo Store never sees or stores your card number.

<!-- source: checkout page ("You will be securely redirected to Stripe"); Stripe-hosted Checkout in src/services/order.service.ts -->

## When is my card charged?

When you complete payment on the Stripe page. Your order is created only after Stripe confirms the payment. If you leave the payment page without paying, no order is created, nothing is charged, and your cart stays as it was.

<!-- source: src/services/order.service.ts (PendingCheckout; the order is created by the checkout.session.completed webhook; cancel_url returns to /cart) -->

## Can I use a discount code?

Checkout doesn't take discount or promo codes.

<!-- source: src/services/order.service.ts (the Stripe session doesn't enable promotion codes) -->
