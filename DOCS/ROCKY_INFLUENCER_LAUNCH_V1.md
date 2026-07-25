# Rocky Influencer Launch System v1

## What v1 automates

- Publishes a dedicated `/creators` landing and application page.
- Protects applications with Turnstile, a honeypot, request limits, and strict
  server-side validation.
- Gives each applicant a stable personal Rocky link immediately.
- Preserves first-touch creator and campaign attribution in the visitor's
  browser.
- Carries a valid referral code into Stripe Checkout and the subscription.
- Confirms referrals from signed Stripe subscription webhooks.
- Stores privacy-safe daily funnel totals instead of raw visitor activity.
- Shows the creator invitation on Rocky's home page only when the program is
  enabled and every required service is ready.

V1 does not send unsolicited messages, publish to social accounts, promise
creator acceptance, or calculate commissions. Those actions need approved
accounts, content, recipients, and written offer terms.

## Safe launch order

Production is committed with `ROCKY_CREATORS_ENABLED` set to `false`. Staging is
set to `true`.

1. Back up the production D1 database.
2. Apply migration `0005_creator_launch.sql` to staging.
3. Deploy and test staging.
4. Apply the same migration to production.
5. Deploy production while the production flag remains off.
6. Verify `/health` reports the existing Rocky systems healthy.
7. Change the production flag to `true`, deploy, and verify `/creators`.

From PowerShell, run these commands from the repository folder:

```powershell
npx.cmd wrangler d1 migrations apply rocky-identity-staging --remote --env staging
npx.cmd wrangler deploy --env staging
```

After staging passes:

```powershell
npx.cmd wrangler d1 migrations apply rocky-identity-production --remote
npx.cmd wrangler deploy
```

## Staging acceptance test

1. Open `/creators` on the staging Worker.
2. Confirm the application form and Turnstile appear.
3. Submit one test creator application.
4. Confirm the success panel returns a personal link beginning with
   `?ref=rocky-`.
5. Open that link in a private browser window.
6. Confirm Rocky's normal question, sign-in, payment, and voice experience are
   unchanged. Do not make a live purchase in staging.
7. Confirm the staging Worker has no new errors.

## Operator reports

Applications awaiting review:

```sql
SELECT
  application_id,
  name,
  email,
  platform,
  profile_url,
  audience_range,
  referral_code,
  source,
  campaign,
  created_at
FROM creator_applications
WHERE status IN ('new', 'reviewing')
ORDER BY created_at ASC;
```

Daily funnel:

```sql
SELECT
  event_date,
  event_name,
  SUM(event_count) AS total
FROM creator_daily_events
GROUP BY event_date, event_name
ORDER BY event_date DESC, event_name ASC;
```

Results by creator:

```sql
WITH creator_visits AS (
  SELECT
    referral_code,
    SUM(event_count) AS visits
  FROM creator_daily_events
  WHERE event_name = 'share_clicked'
  GROUP BY referral_code
),
creator_plus AS (
  SELECT
    referral_code,
    COUNT(DISTINCT stripe_subscription_id) AS confirmed_plus
  FROM creator_referrals
  WHERE status IN ('active', 'trialing', 'past_due')
  GROUP BY referral_code
)
SELECT
  a.name,
  a.platform,
  a.referral_code,
  COALESCE(v.visits, 0) AS visits,
  COALESCE(p.confirmed_plus, 0) AS confirmed_plus
FROM creator_applications AS a
LEFT JOIN creator_visits AS v
  ON v.referral_code = a.referral_code
LEFT JOIN creator_plus AS p
  ON p.referral_code = a.referral_code
ORDER BY confirmed_plus DESC, visits DESC, a.created_at ASC;
```

Run a read-only report from PowerShell:

```powershell
npx.cmd wrangler d1 execute rocky-identity-production --remote --command "SELECT application_id, name, email, platform, audience_range, referral_code, status, created_at FROM creator_applications ORDER BY created_at DESC LIMIT 50"
```

Update an application only after reviewing the public profile:

```powershell
npx.cmd wrangler d1 execute rocky-identity-production --remote --command "UPDATE creator_applications SET status = 'invited', updated_at = datetime('now') WHERE application_id = 'PASTE_APPLICATION_ID'"
```

Allowed statuses are `new`, `reviewing`, `invited`, `declined`, and `active`.

## Creator disclosure rule

If Rocky provides a free product, payment, discount, or another benefit, the
creator must disclose that connection clearly in the post itself. Creators must
describe only their honest experience and must not make unsupported health,
financial, or other claims.

Official guidance:
<https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers>

## Data and secret boundaries

- Application contact details stay in D1 and are not exposed by public APIs.
- Daily event data contains totals, campaign tokens, and referral codes—not raw
  IP addresses, visitor emails, questions, or customer identities.
- Creator links do not reveal subscriber information to creators.
- No Stripe, Turnstile, Clerk, or OpenAI secret is placed in site files,
  analytics records, release notes, or this runbook.
