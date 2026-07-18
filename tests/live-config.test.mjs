import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("production points at the approved Paddle Live catalog but stays disabled", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );
  const config = JSON.parse(source.replace(/^\uFEFF/, ""));

  assert.equal(config.vars.ROCKY_PAYMENTS_ENABLED, "false");
  assert.equal(config.vars.PADDLE_ENVIRONMENT, "production");
  assert.equal(
    config.vars.PADDLE_CLIENT_TOKEN,
    "live_d0cd3f2129cb51871efeb2865ee"
  );
  assert.equal(
    config.vars.PADDLE_MONTHLY_PRICE_ID,
    "pri_01kxstgr8dya0fs6wceakpfmgk"
  );
  assert.equal(
    config.vars.PADDLE_ANNUAL_PRICE_ID,
    "pri_01kxstkh3dwbearsje29hzdyw0"
  );
});
