import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  canonicalRedirectFor,
  healthState
} from "../WEBSITE/functions/site-routing.js";

test("redirects the apex domain to canonical www and preserves the request", () => {
  const result = canonicalRedirectFor(
    "http://rockyaloha.com/ask-rocky?source=apex"
  );

  assert.equal(
    result,
    "https://www.rockyaloha.com/ask-rocky?source=apex"
  );
});

test("does not redirect the canonical or workers.dev hostnames", () => {
  assert.equal(canonicalRedirectFor("https://www.rockyaloha.com/"), null);
  assert.equal(
    canonicalRedirectFor(
      "https://rocky-github-preview.jaiholdings1.workers.dev/"
    ),
    null
  );
});

test("health is ready only when AI and Turnstile are configured", () => {
  const ready = healthState({
    OPENAI_API_KEY: "configured",
    ROCKY_AI_ENABLED: "true",
    TURNSTILE_SITE_KEY: "configured",
    TURNSTILE_SECRET_KEY: "configured"
  });
  const stopped = healthState({
    OPENAI_API_KEY: "configured",
    ROCKY_AI_ENABLED: "false",
    TURNSTILE_SITE_KEY: "configured",
    TURNSTILE_SECRET_KEY: "configured"
  });

  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "ok");
  assert.equal(stopped.status, 503);
  assert.equal(stopped.body.status, "degraded");
});

test("health fails closed when enabled payments are incomplete", () => {
  const degraded = healthState({
    OPENAI_API_KEY: "configured",
    ROCKY_AI_ENABLED: "true",
    TURNSTILE_SITE_KEY: "configured",
    TURNSTILE_SECRET_KEY: "configured",
    ROCKY_PAYMENTS_ENABLED: "true",
    ROCKY_DB: {}
  });
  const ready = healthState({
    OPENAI_API_KEY: "configured",
    ROCKY_AI_ENABLED: "true",
    TURNSTILE_SITE_KEY: "configured",
    TURNSTILE_SECRET_KEY: "configured",
    ROCKY_PAYMENTS_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_not-real",
    STRIPE_MONTHLY_PRICE_ID: "price_month",
    STRIPE_ANNUAL_PRICE_ID: "price_year",
    STRIPE_WEBHOOK_SECRET: "whsec_not-real",
    ROCKY_DB: {}
  });

  assert.equal(degraded.status, 503);
  assert.equal(degraded.body.paymentsReady, false);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.paymentsReady, true);
});

test("homepage declares the www production URL as canonical", async () => {
  const html = await readFile(
    new URL("../WEBSITE/index.html", import.meta.url),
    "utf8"
  );

  assert.match(
    html,
    /<link rel="canonical" href="https:\/\/www\.rockyaloha\.com\/">/
  );
});
