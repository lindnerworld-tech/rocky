PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS creator_applications (
  application_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'reviewing', 'invited', 'declined', 'active')),
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  platform TEXT NOT NULL
    CHECK (
      platform IN (
        'instagram', 'tiktok', 'youtube', 'facebook', 'x',
        'linkedin', 'podcast', 'blog', 'other'
      )
    ),
  profile_url TEXT NOT NULL,
  audience_range TEXT NOT NULL
    CHECK (
      audience_range IN (
        'under-1k', '1k-10k', '10k-50k', '50k-250k', '250k-plus'
      )
    ),
  message TEXT NOT NULL,
  referral_code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  source TEXT NOT NULL DEFAULT 'direct',
  campaign TEXT NOT NULL DEFAULT 'founding20',
  consent_at TEXT NOT NULL,
  last_contacted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS creator_applications_status_created_idx
  ON creator_applications(status, created_at);

CREATE TABLE IF NOT EXISTS creator_daily_events (
  event_date TEXT NOT NULL,
  event_name TEXT NOT NULL
    CHECK (
      event_name IN (
        'landing_view', 'application_started', 'application_submitted',
        'share_link_created', 'share_clicked', 'checkout_started'
      )
    ),
  referral_code TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'direct',
  campaign TEXT NOT NULL DEFAULT 'founding20',
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (
    event_date,
    event_name,
    referral_code,
    source,
    campaign
  )
) STRICT;

CREATE TABLE IF NOT EXISTS creator_referrals (
  stripe_subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  referral_code TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL,
  stripe_event_id TEXT NOT NULL,
  occurred_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (referral_code)
    REFERENCES creator_applications(referral_code) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS creator_referrals_code_status_idx
  ON creator_referrals(referral_code, status);
