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
    )
  ]);
  const migration = migrations.join("\n");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS entitlements/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS usage_daily/);
  assert.doesNotMatch(migration, /email/i);
  assert.doesNotMatch(migration, /question/i);
});

test("homepage does not expose the retired Paddle checkout", async () => {
  const html = await readFile(
    new URL("../WEBSITE/index.html", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(html, /cdn\.paddle\.com/);
  assert.doesNotMatch(html, /Paddle\.Checkout/);
  assert.doesNotMatch(html, /paddle-checkout-context/);
  assert.doesNotMatch(html, /PADDLE_WEBHOOK_SECRET/);
  assert.doesNotMatch(html, /ROCKY_CHECKOUT_SECRET/);
});
