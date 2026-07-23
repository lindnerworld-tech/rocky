import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("homepage loads Clerk only when identity configuration is enabled", async () => {
  const html = await readFile(
    new URL("../WEBSITE/index.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /config\.identity\?\.enabled/);
  assert.match(html, /data-clerk-publishable-key/);
  assert.match(html, /window\.Clerk\.openSignIn\(\)/);
  assert.match(html, /window\.Clerk\.session\.getToken\(\)/);
  assert.match(html, /headers\.Authorization = `Bearer \$\{token\}`/);
  assert.doesNotMatch(html, /CLERK_JWT_KEY/);
});

test("D1 migration stores no email address or raw Rocky question", async () => {
  const migrations = await Promise.all([
    readFile(
      new URL("../migrations/0001_identity_entitlements.sql", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../migrations/0002_paddle_entitlements.sql", import.meta.url),
      "utf8"
    ),
    readFile(
      new URL("../migrations/0003_stripe_entitlements.sql", import.meta.url),
      "utf8"
    )
  ]);
  const migration = migrations.join("\n");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS entitlements/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS usage_daily/);
  assert.match(migration, /stripe_subscription_id/);
  assert.match(migration, /'stripe'/);
  assert.doesNotMatch(migration, /email/i);
  assert.doesNotMatch(migration, /question/i);
});

test("homepage uses server-created Stripe Checkout and exposes no secrets", async () => {
  const html = await readFile(
    new URL("../WEBSITE/index.html", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(html, /cdn\.paddle\.com/);
  assert.doesNotMatch(html, /Paddle\.Checkout/);
  assert.doesNotMatch(html, /paddle-checkout-context/);
  assert.match(html, /fetch\("\/create-checkout-session"/);
  assert.match(html, /window\.location\.assign\(result\.checkoutUrl\)/);
  assert.match(html, /Choose annual · \$59\/year/);
  assert.match(html, /Monthly · \$7\.99/);
  assert.doesNotMatch(html, /STRIPE_SECRET_KEY/);
  assert.doesNotMatch(html, /STRIPE_WEBHOOK_SECRET/);
  assert.doesNotMatch(html, /PADDLE_WEBHOOK_SECRET/);
  assert.doesNotMatch(html, /ROCKY_CHECKOUT_SECRET/);
});

test("production keeps charging off while retaining the approved Stripe prices", async () => {
  const config = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );

  assert.match(config, /"ROCKY_PAYMENTS_ENABLED": "false"/);
  assert.match(config, /price_1TwEBR9yakPvhQdpkVD7vDlk/);
  assert.match(config, /price_1TwDzA9yakPvhQdpamdErN02/);
  assert.match(config, /price_1TwEy7QAn31d66ev8DGXt8Mo/);
  assert.match(config, /price_1TwF0sQAn31d66evWfDKeRUL/);
  assert.doesNotMatch(config, /STRIPE_SECRET_KEY/);
  assert.doesNotMatch(config, /STRIPE_WEBHOOK_SECRET/);
});
