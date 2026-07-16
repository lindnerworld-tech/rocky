# Project Rocky protection activation

The protection code is designed to fail closed until Cloudflare Turnstile is configured. Do not merge the protection branch into `main` until the staging deployment passes the checks below.

Cloudflare does not generate version preview URLs for Workers that implement Durable Objects. Rocky therefore uses a separate Wrangler `staging` environment so branch builds can never replace the production Worker.

## 1. Create the Turnstile widget

In Cloudflare, create a Managed Turnstile widget for Rocky. Add both hostnames:

- `rocky-github-preview.jaiholdings1.workers.dev`
- `rocky-github-preview-staging.jaiholdings1.workers.dev`

Record the two generated values:

- Site key — safe to expose to the browser.
- Secret key — keep only in Cloudflare's encrypted secrets.

Never paste the secret key into GitHub, source code, a commit, or a support message.

## 2. Configure branch builds

In the production Worker's build settings, set the non-production branch deploy command to:

```text
npx wrangler deploy --env staging
```

This deploys branch code to the separate `rocky-github-preview-staging` Worker. The production deploy command remains `npx wrangler deploy` and only runs for `main`.

## 3. Configure the staging Worker

Run one staging build to create `rocky-github-preview-staging`, then add these settings to that Worker:

- `TURNSTILE_SITE_KEY` as a normal environment variable.
- `TURNSTILE_SECRET_KEY` as an encrypted secret.
- `OPENAI_API_KEY` as an encrypted secret.

Secrets and variables are environment-specific and are not inherited from the production Worker.

Before merging, confirm the production `rocky-github-preview` Worker also has `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, and `OPENAI_API_KEY`.

The following non-secret defaults are declared in `wrangler.jsonc`:

- `ROCKY_AI_ENABLED=true`
- `ROCKY_DAILY_IP_LIMIT=3`
- `ROCKY_GLOBAL_DAILY_LIMIT=500` in production and `25` in staging

The production Worker also enforces five requests per minute per IP and sixty requests per minute across each Cloudflare location. Staging has a lower global burst ceiling.

## 4. Staging acceptance check

Before merging:

1. Open `https://rocky-github-preview-staging.jaiholdings1.workers.dev` and confirm the Ask Rocky button becomes active after Turnstile loads.
2. Submit one normal question and confirm Rocky answers.
3. Submit an invalid or reused token and confirm the request is rejected.
4. Set `ROCKY_AI_ENABLED=false` in staging and confirm Ask Rocky returns the resting message without calling OpenAI.
5. Restore `ROCKY_AI_ENABLED=true`.

## Emergency stop

Set `ROCKY_AI_ENABLED=false` in Cloudflare and redeploy. The endpoint will return a controlled `503` response before Turnstile, counters, or OpenAI are called.
