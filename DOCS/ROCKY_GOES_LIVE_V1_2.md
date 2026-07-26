# Rocky Goes Live v1.2

Date: July 25, 2026

V1.2 connects the finished Rocky Goes Live media package to the live Creator
Circle. It does not remake the approved v1.1 cards or videos.

## Live launch baseline

- Rocky answers and speaks at `https://www.rockyaloha.com`.
- Stripe hosted Checkout accepts Rocky Plus subscriptions.
- The first production Rocky Plus payment completed successfully.
- Subscription webhooks and the daily Rocky Plus allowance are active.
- The approved spoken voice remains `gpt-4o-mini-tts`, `onyx`, speed `0.78`.
- The Founding 20 Creator Circle is enabled in production.
- Production payments and voice remain enabled; staging payments and voice
  remain disabled.

## V1.2 media upgrade

- The approved source was identified by its embedded title:
  `Rocky V08 - Now Live`.
- The web copy is H.264/AAC, 720 by 1280 pixels, 12.27 seconds, and optimized
  for progressive playback.
- The opening `ROCKY IS LIVE.` frame is the matching social and video poster.
- The Creator Circle now includes a `#meet-rocky` launch-film section with
  native controls, inline mobile playback, a direct fallback link, and clear
  calls to ask Rocky or apply as a creator.
- Creator-page Open Graph metadata uses the matching poster and hosted video.

Published assets:

- `/rocky-v08-now-live.mp4`
- `/rocky-v08-now-live-poster.jpg`
- `/creators#meet-rocky`

## Outreach handoff

Creator outreach should link to:

`https://www.rockyaloha.com/creators#meet-rocky`

The weekday outreach workflow may check replies and prepare one personalized
draft at a time. It must not send automatically. Every recipient and message
still requires human review.

The v1.1 posting calendar remains source material. V1.2 does not claim that
Rocky can publish to social accounts until approved social accounts and posting
connections exist.

## Safeguards preserved

- No secret key or customer record is stored in the website, media, document,
  commit, or release notes.
- No standalone Stripe Payment Links are introduced.
- Creator attribution remains privacy-safe and uses confirmed Stripe
  subscription webhooks.
- Creator applications remain protected by Turnstile, server-side validation,
  rate limits, and the existing disclosure rules.
- The existing production and staging D1 databases remain untouched by this
  release.

See `DOCS/ROCKY_INFLUENCER_LAUNCH_V1.md` before any future D1 schema work. The
existing databases do not have reliable Wrangler migration history, so never
replay the historical migration set against them.

## Acceptance checks

1. Open `/creators#meet-rocky` in staging.
2. Confirm the poster loads before playback.
3. Play the full video with sound and confirm it remains inside the page on
   mobile.
4. Confirm both `Ask Rocky` and `Become a creator` links work.
5. Submit one protected staging creator application.
6. Confirm staging payments and voice are still disabled.
7. Deploy production only after automated tests and both Wrangler dry-runs
   pass.
8. Confirm production health, configuration, video playback, Creator Circle,
   payments, and voice after deployment.
