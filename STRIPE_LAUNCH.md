# Project Rocky Stripe launch

Rocky uses Stripe-hosted Checkout with Managed Payments. The browser sends only
`monthly` or `annual`; the Worker maps that choice to an approved Stripe Price
ID and creates the Checkout Session on the server.

## Live catalog

- Monthly — $7.99 USD: `price_1TwEBR9yakPvhQdpkVD7vDlk`
- Annual — $59.00 USD: `price_1TwDzA9yakPvhQdpamdErN02`

## Sandbox catalog

- Monthly — $7.99 USD: `price_1TwEy7QAn31d66ev8DGXt8Mo`
- Annual — $59.00 USD: `price_1TwF0sQAn31d66evWfDKeRUL`

These identifiers are safe to store in source. Stripe secret keys and webhook
signing secrets are not.

## Current safety state

- Production payments: disabled with `ROCKY_PAYMENTS_ENABLED=false`
- Staging payments: disabled until its database migration and end-to-end tests
  are complete
- Stripe sandbox webhook destination: active for five subscription events
- Stripe sandbox API and webhook secrets: stored as encrypted staging secrets
- Checkout: Stripe-hosted, Managed Payments enabled
- Access: granted only from signed Stripe subscription webhooks
- Duplicate webhook events: ignored
- Unknown prices and untrusted account metadata: rejected

## Four go-live gates

1. **Stripe ready**
   - Activate Managed Payments and accept its terms in the live Dashboard.
   - Confirm both live products remain marked eligible for Managed Payments.
   - Matching monthly and annual Stripe sandbox products are created.

2. **Cloudflare ready**
   - Apply D1 migration `0003_stripe_entitlements.sql` to staging, then
     production.
   - Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` as encrypted Worker
     secrets. Never place either value in GitHub, source code, or chat.
   - Sandbox Price IDs are declared in the staging Worker configuration.

3. **Webhook ready**
   - In Stripe, create a live webhook endpoint:
     `https://www.rockyaloha.com/stripe-webhook`
   - Subscribe it to:
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `customer.subscription.paused`
     - `customer.subscription.resumed`
   - Use API version `2025-03-31.basil` or later.
   - Create an equivalent webhook endpoint for the staging Worker in sandbox.

4. **End-to-end proof**
   - Enable payments in staging only.
   - Complete one monthly and one annual sandbox Checkout.
   - Confirm each signed-in account changes from Rocky Free to Rocky Plus.
   - Cancel one sandbox subscription and confirm access returns to Rocky Free.
   - Confirm repeated delivery of the same Stripe event does not change access
     twice.

After all four gates pass, change production
`ROCKY_PAYMENTS_ENABLED` to `true` in a separate, reviewable go-live commit.

## Emergency stop

Set `ROCKY_PAYMENTS_ENABLED=false` and redeploy. This stops new Checkout
Sessions. Stripe continues to retain subscription and payment records.
