PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS entitlements (
  user_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'plus')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'expired')),
  source TEXT NOT NULL DEFAULT 'signup'
    CHECK (source IN ('signup', 'manual', 'paddle', 'gift')),
  current_period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  answer_count INTEGER NOT NULL DEFAULT 0 CHECK (answer_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, usage_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS usage_daily_date_idx
  ON usage_daily(usage_date);

CREATE TABLE IF NOT EXISTS entitlement_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  user_id TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) STRICT;
