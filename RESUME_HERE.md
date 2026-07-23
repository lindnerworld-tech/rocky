# Project Rocky — Resume Here

Checkpoint date: 2026-07-23

## Current state

- Stripe-hosted monthly and annual sandbox Checkout passed end to end.
- Immediate cancellation returned the account to Rocky Free.
- The authenticated **Manage subscription** customer portal works.
- Cancellation webhooks continue processing when new checkout is disabled.
- Stripe entitlement migrations are applied to staging and production D1.
- All 43 automated tests pass.
- Cloudflare staging bundle validation passes.
- Staging payments are disabled.
- Production payments are disabled.
- Production cannot charge customers.

## Current blocker

Stripe is reviewing Craig Lindner's representative address, identity document,
and ID number. The Dashboard says no further action is required. Payments and
payouts remain paused until Stripe clears the review.

## Exact next mission

After Stripe approves the live account, configure the live webhook and encrypted
production Stripe secrets while keeping `ROCKY_PAYMENTS_ENABLED=false`.
Verify the complete production configuration, then enable production payments
only as a separate final go-live action.

## Working checkpoint

- Branch: `agent/stripe-staging-safe`
- Draft PR: https://github.com/lindnerworld-tech/rocky/pull/12
- Public site: https://www.rockyaloha.com
- Staging site: https://rocky-github-preview-staging.jaiholdings1.workers.dev
