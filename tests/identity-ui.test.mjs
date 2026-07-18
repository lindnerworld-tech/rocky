import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

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
  assert.match(html, /if \(!window\.Paddle\.Initialized\)/);
  assert.match(html, /pwCustomer: paddleCustomerId/);
  assert.match(html, /\? \{ id: paddleCustomerId \}\s+: \{\}/);
  assert.match(html, /Paddle\.Update\(\{\s*pwCustomer:/);
  assert.match(html, /updatePaddleRetainCustomer\(access\)/);
  assert.match(html, /updatePaddleRetainCustomer\(null\)/);
  assert.match(html, /paddle-checkout-context/);
  assert.match(html, /customData\.error === "already_plus"/);
  assert.match(html, /setCheckoutButtonsDisabled\(true\)/);
  assert.match(html, /checkout\.closed" && !checkoutCompleted/);
  assert.doesNotMatch(html, /PADDLE_WEBHOOK_SECRET/);
  assert.doesNotMatch(html, /ROCKY_CHECKOUT_SECRET/);
});

test("Retain customer binding follows account changes and clears on sign-out", async () => {
  const html = await readFile(
    new URL("../WEBSITE/index.html", import.meta.url),
    "utf8"
  );
  const start = html.indexOf("    function paddleCustomerIdFor(access)");
  const end = html.indexOf("    async function openPlusCheckout", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const helpers = html.slice(start, end);
  const context = {
    window: {
      Paddle: {
        Initialized: true,
        Update(config) {
          context.updates.push(config);
        }
      }
    },
    updates: []
  };

  vm.runInNewContext(`
    let paddleConfig = { environment: "production" };
    let paddleRetainCustomerId = null;
    ${helpers}
    updatePaddleRetainCustomer({ paddleCustomerId: "ctm_accountA" });
    updatePaddleRetainCustomer({ paddleCustomerId: "ctm_accountA" });
    updatePaddleRetainCustomer({ paddleCustomerId: "ctm_accountB" });
    updatePaddleRetainCustomer(null);
    globalThis.finalCustomerId = paddleRetainCustomerId;
    window.Paddle.Update = () => { throw new Error("Retain unavailable"); };
    updatePaddleRetainCustomer({ paddleCustomerId: "ctm_accountC" });
    globalThis.customerIdAfterFailedUpdate = paddleRetainCustomerId;
  `, context);

  assert.deepEqual(JSON.parse(JSON.stringify(context.updates)), [
    { pwCustomer: { id: "ctm_accountA" } },
    { pwCustomer: { id: "ctm_accountB" } },
    { pwCustomer: {} }
  ]);
  assert.equal(context.finalCustomerId, "");
  assert.equal(context.customerIdAfterFailedUpdate, "");
});
