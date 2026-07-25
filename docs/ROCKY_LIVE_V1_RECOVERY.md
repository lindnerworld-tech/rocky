# Project Rocky Live v1.0 Recovery Guide

**Status:** Official live-launch recovery baseline  
**Checkpoint date:** July 25, 2026  
**Public site:** https://www.rockyaloha.com  
**Release/tag:** `rocky-live-v1.0`  
**Golden commit:** `9385a60d4ab07f1cbb65e415dfa02d8d976c0c02`

This guide records how to reconstruct the first fully operational Project Rocky
production system. It intentionally contains no secret values, customer data,
private backup locations, or temporary download links.

## Known-good baseline

The tagged baseline has been verified end to end:

- Rocky answers protected questions.
- Clerk identity and daily allowances work.
- Stripe Managed Payments opens hosted subscription Checkout.
- Subscription webhooks update Plus entitlements.
- Rocky's approved spoken voice works in production.
- Production payments and voice are enabled.
- Staging payments and voice are disabled.

## Authoritative sources

Do not re-create settings from memory. Use these checked-in sources:

| Purpose | Authoritative source |
| --- | --- |
| Cloudflare Workers, D1, limits, environment flags, public configuration | `wrangler.jsonc` |
| Worker routes and health/config endpoints | `worker.mjs` |
| Stripe Checkout and webhook behavior | `WEBSITE/functions/payments.js` |
| Identity and daily allowances | `WEBSITE/functions/identity.js` |
| Approved voice recipe and speaking instructions | `WEBSITE/functions/rocky-voice.js` |
| Database schema history | `migrations/` |
| Automated verification | `test/` |

The exact Cloudflare resource identifiers and Stripe Price IDs needed by the app
are already preserved in `wrangler.jsonc`. Avoid copying them into secondary
documents where they can drift.

## Required services

A complete production restoration requires:

- GitHub repository `lindnerworld-tech/rocky`
- Cloudflare Worker and static assets
- Cloudflare D1 production database
- Cloudflare rate-limit bindings and Durable Object
- Cloudflare Turnstile
- Clerk identity configuration
- Stripe Managed Payments with hosted Checkout
- Stripe production subscription webhook
- OpenAI answer and text-to-speech access
- Canonical domain `www.rockyaloha.com`

## Required Cloudflare values

Store secret values only in Cloudflare and an approved private password manager.
Never commit the values to GitHub or paste them into support messages.

- `OPENAI_API_KEY`
- `TURNSTILE_SECRET_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

Required public configuration value:

- `TURNSTILE_SITE_KEY`

Clerk public keys and most non-secret environment values are preserved in the
checked-in configuration. The Turnstile site key must be retained in Cloudflare
or retrieved from the Turnstile widget settings during a rebuild.

## Stripe baseline

- Provider: Stripe Managed Payments
- Checkout: Stripe hosted subscription Checkout
- Production webhook: `https://www.rockyaloha.com/stripe-webhook`
- No standalone Payment Links
- Accepted monthly and annual Price IDs are defined in `wrangler.jsonc`
- Subscription event allowlist is defined in `WEBSITE/functions/payments.js`
- The full live secret key must be installed in Cloudflare; a masked Dashboard
  display such as `sk_live_...xxxx` is not a usable key

## Rocky's approved spoken voice

The complete approved instructions are preserved in
`WEBSITE/functions/rocky-voice.js`.

| Setting | Approved value |
| --- | --- |
| Model | `gpt-4o-mini-tts` |
| Voice | `onyx` |
| Speed | `0.78` |
| Audio format | MP3 |
| Disclosure | `AI-generated voice` |
| Speech ticket lifetime | 5 minutes |

The intended result is ancient and elemental—as if a mountain learned to speak:
low baritone, deep resonance, weathered strength, slow deliberate cadence, and
quiet authority. Do not substitute a younger or brighter voice without an
explicitly approved replacement.

## Identity and allowance baseline

- Free signed-in allowance: 1 answer per UTC day
- Rocky Plus allowance: 20 answers per UTC day
- Active and trialing subscriptions receive Plus access
- Canceled subscriptions retain access only through a valid paid period
- D1 stores identity, entitlement, usage, and processed-event state
- Webhook processing is idempotent

## Database protection

Cloudflare D1 Time Travel provides short-term point-in-time recovery. A full SQL
export of the production database was also created at launch and stored in two
private locations outside this public repository.

The SQL export contains private customer and subscription data. Never commit,
attach, or paste it into GitHub.

To make a new private export from a safe local directory:

```powershell
npx.cmd wrangler d1 export rocky-identity-production --remote --output=.\Project-Rocky-D1-Backup.sql
```

## Clean recovery order

1. Check out tag `rocky-live-v1.0` or the golden commit shown above.
2. Run `npm install`, then `npm test`.
3. Re-create or confirm the resources defined by `wrangler.jsonc`.
4. Install the required production secret values directly in Cloudflare.
5. Bind the correct production D1 database.
6. Use the private SQL export only when rebuilding a blank replacement database.
   Never import it over healthy production data.
7. Deploy with `npx.cmd wrangler deploy`.
8. Verify `/health` reports `status: ok`.
9. Verify `/rocky-config` reports production identity, payments, and voice ready
   without exposing secrets.
10. Sign in, ask one new question, and confirm the allowance counter and
    **Hear Rocky** playback.
11. Confirm Checkout opens and subscription webhook deliveries succeed before
    accepting general traffic.

## Live smoke-test checklist

- Canonical website loads and redirects correctly.
- Turnstile protection is ready.
- Clerk sign-in works.
- `/me` returns the correct plan and allowance.
- Rocky provides a new answer.
- **Hear Rocky** plays the approved voice.
- Monthly and annual buttons open Stripe hosted Checkout.
- Production webhook deliveries succeed.
- Plus entitlement appears after payment.
- Production payments and voice stay enabled.
- Staging payments and voice stay disabled.

## Change control

- Treat `rocky-live-v1.0` as the known-good emergency baseline.
- Test payment, identity, database, and voice changes in staging first.
- Export D1 before schema or entitlement changes.
- Never copy masked Stripe values into Cloudflare.
- Never commit secrets, database exports, customer records, or temporary signed
  download links.
- If production health becomes degraded, disable the affected feature switch
  before experimenting.

## Physical Project Rocky checkpoint

The Original 20 Glowforge package is complete. Stones are numbered 01 OF 20
through 20 OF 20, and all 20 QR codes were verified. The current physical mission
remains: make and inspect Stone 01. NFC, personalized founder pages, and the
display cradle remain future ideas, not active work.
