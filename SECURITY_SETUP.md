# Project Rocky protection activation

The protection code is designed to fail closed until Cloudflare Turnstile is configured. Do not merge the protection branch into `main` until the preview deployment passes the checks below.

## 1. Create the Turnstile widget

In Cloudflare, create a Managed Turnstile widget for Rocky. Add Rocky's production hostname and the Cloudflare preview hostname used to test this branch.

Record the two generated values:

- Site key — safe to expose to the browser.
- Secret key — keep only in Cloudflare's encrypted secrets.

Never paste the secret key into GitHub, source code, a commit, or a support message.

## 2. Configure the Worker

Add these settings to the Worker deployment:

- `TURNSTILE_SITE_KEY` as a normal environment variable.
- `TURNSTILE_SECRET_KEY` as an encrypted secret.

The following non-secret defaults are already declared in `wrangler.jsonc`:

- `ROCKY_AI_ENABLED=true`
- `ROCKY_DAILY_IP_LIMIT=3`
- `ROCKY_GLOBAL_DAILY_LIMIT=500`

The Worker also enforces five requests per minute per IP and sixty requests per minute across each Cloudflare location.

## 3. Preview acceptance check

Before merging:

1. Open the branch preview and confirm the Ask Rocky button becomes active after Turnstile loads.
2. Submit one normal question and confirm Rocky answers.
3. Submit an invalid or reused token and confirm the request is rejected.
4. Set `ROCKY_AI_ENABLED=false` in the preview and confirm Ask Rocky returns the resting message without calling OpenAI.
5. Restore `ROCKY_AI_ENABLED=true`.

## Emergency stop

Set `ROCKY_AI_ENABLED=false` in Cloudflare and redeploy. The endpoint will return a controlled `503` response before Turnstile, counters, or OpenAI are called.
