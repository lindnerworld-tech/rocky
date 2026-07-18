ALTER TABLE entitlements ADD COLUMN paddle_subscription_id TEXT;
ALTER TABLE entitlements ADD COLUMN paddle_customer_id TEXT;
ALTER TABLE entitlements ADD COLUMN paddle_price_id TEXT;
ALTER TABLE entitlements ADD COLUMN last_event_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS entitlements_paddle_subscription_idx
  ON entitlements(paddle_subscription_id)
  WHERE paddle_subscription_id IS NOT NULL;

