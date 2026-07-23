PRAGMA defer_foreign_keys = ON;

CREATE TABLE entitlements_without_paddle (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'plus')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'expired')),
  source TEXT NOT NULL DEFAULT 'signup'
    CHECK (source IN ('signup', 'manual', 'stripe', 'gift')),
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_at TEXT,
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  stripe_price_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

INSERT INTO entitlements_without_paddle (
  user_id,
  plan,
  status,
  source,
  current_period_end,
  created_at,
  updated_at,
  last_event_at,
  stripe_subscription_id,
  stripe_customer_id,
  stripe_price_id
)
SELECT
  user_id,
  plan,
  status,
  source,
  current_period_end,
  created_at,
  updated_at,
  last_event_at,
  stripe_subscription_id,
  stripe_customer_id,
  stripe_price_id
FROM entitlements;

DROP TABLE entitlements;
ALTER TABLE entitlements_without_paddle RENAME TO entitlements;

CREATE UNIQUE INDEX IF NOT EXISTS entitlements_stripe_subscription_idx
  ON entitlements(stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
