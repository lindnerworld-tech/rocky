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

test("homepage loads Paddle only when public payment configuration is ready", async () => {
  const html = await readFile(
    new URL("../WEBSITE/index.html", import.meta.url),
    "utf8"
  );

  assert.match(html, /config\.payments\?\.enabled/);
  assert.match(html, /cdn\.paddle\.com\/paddle\/v2\/paddle\.js/);
  assert.match(html, /Paddle\.Environment\.set\("sandbox"\)/);
  assert.match(html, /Paddle\.Checkout\.open/);
  assert.match(html, /pwCustomer: \{ id: paddleCustomerId \}/);
  assert.match(html, /paddle-checkout-context/);
  assert.match(html, /customData\.error === "already_plus"/);
  assert.match(html, /setCheckoutButtonsDisabled\(true\)/);
  assert.match(html, /checkout\.closed" && !checkoutCompleted/);
  assert.doesNotMatch(html, /PADDLE_WEBHOOK_SECRET/);
  assert.doesNotMatch(html, /ROCKY_CHECKOUT_SECRET/);
});
