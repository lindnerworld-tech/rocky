import test from "node:test";
import assert from "node:assert/strict";

import {
  createStripeBillingPortal,
  createStripeCheckout,
  handleStripeWebhook,
  paymentsConfiguration,
  processStripeEvent,
  verifyStripeSignature
} from "../WEBSITE/functions/payments.js";

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async first() {
    if (this.sql.includes("SELECT processed_at FROM entitlement_events")) {
      const event = this.db.events.get(this.params[0]);
      return event ? { processed_at: event.processedAt } : null;
    }
    if (this.sql.includes("SELECT stripe_customer_id")) {
      const entitlement = this.db.entitlements.get(this.params[0]);
      return entitlement
        ? { stripe_customer_id: entitlement.customerId }
        : null;
    }
    if (this.sql.includes("WHERE stripe_subscription_id = ?")) {
      for (const [userId, entitlement] of this.db.entitlements) {
        if (entitlement.subscriptionId === this.params[0]) {
          return { user_id: userId };
        }
      }
      return null;
    }
    throw new Error(`Unexpected first SQL: ${this.sql}`);
  }

  async run() {
    if (this.sql.includes("INSERT OR IGNORE INTO entitlement_events")) {
      const [eventId, eventType, receivedAt] = this.params;
      if (!this.db.events.has(eventId)) {
        this.db.events.set(eventId, {
          eventType,
          receivedAt,
          processedAt: null,
          userId: null
        });
      }
      return { success: true };
    }

    if (this.sql.includes("INSERT OR IGNORE INTO users")) {
      this.db.users.add(this.params[0]);
      return { success: true };
    }

    if (this.sql.includes("INSERT INTO entitlements")) {
      const [
        userId,
        status,
        currentPeriodEnd,
        createdAt,
        updatedAt,
        subscriptionId,
        customerId,
        priceId,
        occurredAt
      ] = this.params;
      const existing = this.db.entitlements.get(userId);
      if (!existing || !existing.lastEventAt || occurredAt >= existing.lastEventAt) {
        this.db.entitlements.set(userId, {
          plan: "plus",
          status,
          currentPeriodEnd,
          createdAt: existing?.createdAt || createdAt,
          updatedAt,
          subscriptionId,
          customerId,
          priceId,
          lastEventAt: occurredAt
        });
      }
      return { success: true };
    }

    if (this.sql.includes("UPDATE entitlement_events")) {
      const [userId, processedAt, eventId] = this.params;
      const event = this.db.events.get(eventId);
      if (event) {
        event.userId = userId;
        event.processedAt = processedAt;
      }
      return { success: true };
    }

    throw new Error(`Unexpected run SQL: ${this.sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.events = new Map();
    this.users = new Set();
    this.entitlements = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function makeEnv(db = new FakeD1()) {
  return {
    ROCKY_DB: db,
    ROCKY_PAYMENTS_ENABLED: "true",
    ROCKY_SITE_URL: "https://www.rockyaloha.com",
    STRIPE_SECRET_KEY: "sk_test_not-a-real-key",
    STRIPE_MONTHLY_PRICE_ID: "price_month",
    STRIPE_ANNUAL_PRICE_ID: "price_year",
    STRIPE_WEBHOOK_SECRET: "whsec_test-secret"
  };
}

async function stripeSignature(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const hex = Array.from(new Uint8Array(signature), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `t=${timestamp},v1=${hex}`;
}

function subscriptionEvent({
  eventId = "evt_01test",
  eventType = "customer.subscription.created",
  status = "active",
  created = Date.parse("2026-07-17T12:00:00.000Z") / 1000,
  priceId = "price_month",
  userId = "user_rocky",
  includeMetadata = true
} = {}) {
  return {
    id: eventId,
    type: eventType,
    created,
    data: {
      object: {
        id: "sub_01rocky",
        customer: "cus_01rocky",
        status,
        metadata: includeMetadata ? { rocky_user_id: userId } : {},
        items: {
          data: [{
            current_period_end:
              Date.parse("2026-08-17T12:00:00.000Z") / 1000,
            price: { id: priceId }
          }]
        }
      }
    }
  };
}

test("payments configuration exposes status but no Stripe secrets or price IDs", () => {
  const config = paymentsConfiguration(makeEnv());
  assert.deepEqual(config, {
    enabled: true,
    ready: true,
    provider: "stripe",
    checkout: "hosted"
  });
  assert.equal("secretKey" in config, false);
  assert.equal("webhookSecret" in config, false);
  assert.equal("monthlyPriceId" in config, false);

  const incomplete = makeEnv();
  delete incomplete.STRIPE_WEBHOOK_SECRET;
  assert.equal(paymentsConfiguration(incomplete).ready, false);
});

test("Stripe signature verification rejects changed and stale payloads", async () => {
  const rawBody = JSON.stringify({ id: "evt_01test" });
  const now = new Date("2026-07-17T12:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000);
  const header = await stripeSignature("whsec_test-secret", timestamp, rawBody);

  assert.equal(
    await verifyStripeSignature(rawBody, header, "whsec_test-secret", now),
    true
  );
  assert.equal(
    await verifyStripeSignature(
      `${rawBody} `,
      header,
      "whsec_test-secret",
      now
    ),
    false
  );
  assert.equal(
    await verifyStripeSignature(
      rawBody,
      header,
      "whsec_test-secret",
      new Date("2026-07-17T12:10:00.000Z")
    ),
    false
  );
});

test("checkout requires a signed-in Rocky account", async () => {
  const request = new Request("https://www.rockyaloha.com/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "monthly" })
  });
  const result = await createStripeCheckout(
    request,
    makeEnv(),
    async () => {
      throw new Error("Stripe must not be called");
    },
    async () => ({ authenticated: false })
  );

  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: "sign_in_required" });
});

test("checkout maps an approved plan to a server-side Stripe price", async () => {
  let stripeRequest;
  const request = new Request("https://www.rockyaloha.com/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      plan: "monthly",
      priceId: "price_attacker_controlled"
    })
  });
  const result = await createStripeCheckout(
    request,
    makeEnv(),
    async (url, init) => {
      stripeRequest = { url, init };
      return new Response(JSON.stringify({
        id: "cs_test_rocky",
        url: "https://checkout.stripe.com/c/pay/cs_test_rocky"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    async () => ({ authenticated: true, userId: "user_rocky" }),
    async () => ({ plan: "free" })
  );

  assert.equal(result.status, 200);
  assert.equal(
    result.body.checkoutUrl,
    "https://checkout.stripe.com/c/pay/cs_test_rocky"
  );
  assert.equal(stripeRequest.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(stripeRequest.init.headers.Authorization, "Bearer sk_test_not-a-real-key");
  assert.equal(stripeRequest.init.headers["Stripe-Version"], "2025-03-31.basil");

  const form = new URLSearchParams(stripeRequest.init.body);
  assert.equal(form.get("line_items[0][price]"), "price_month");
  assert.equal(form.get("line_items[0][quantity]"), "1");
  assert.equal(form.get("managed_payments[enabled]"), "true");
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("client_reference_id"), "user_rocky");
  assert.equal(
    form.get("subscription_data[metadata][rocky_user_id]"),
    "user_rocky"
  );
  assert.equal(
    form.get("success_url"),
    "https://www.rockyaloha.com/?checkout=success"
  );
  assert.equal(
    form.get("cancel_url"),
    "https://www.rockyaloha.com/?checkout=canceled"
  );
  assert.equal(stripeRequest.init.body.includes("price_attacker_controlled"), false);
});

test("checkout rejects unknown plans and existing Plus accounts", async () => {
  const unknownPlan = await createStripeCheckout(
    new Request("https://www.rockyaloha.com/create-checkout-session", {
      method: "POST",
      body: JSON.stringify({ plan: "lifetime" })
    }),
    makeEnv(),
    async () => {
      throw new Error("Stripe must not be called");
    },
    async () => ({ authenticated: true, userId: "user_rocky" }),
    async () => ({ plan: "free" })
  );
  assert.equal(unknownPlan.status, 400);
  assert.deepEqual(unknownPlan.body, { error: "invalid_plan" });

  const alreadyPlus = await createStripeCheckout(
    new Request("https://www.rockyaloha.com/create-checkout-session", {
      method: "POST",
      body: JSON.stringify({ plan: "annual" })
    }),
    makeEnv(),
    async () => {
      throw new Error("Stripe must not be called");
    },
    async () => ({ authenticated: true, userId: "user_rocky" }),
    async () => ({ plan: "plus" })
  );
  assert.equal(alreadyPlus.status, 409);
  assert.deepEqual(alreadyPlus.body, { error: "already_plus" });
});

test("billing portal uses the authenticated user's stored Stripe customer", async () => {
  const db = new FakeD1();
  db.entitlements.set("user_rocky", {
    customerId: "cus_01rocky"
  });
  const env = makeEnv(db);
  env.ROCKY_PAYMENTS_ENABLED = "false";
  let stripeRequest;

  const result = await createStripeBillingPortal(
    new Request(
      "https://www.rockyaloha.com/create-billing-portal-session",
      { method: "POST" }
    ),
    env,
    async (url, init) => {
      stripeRequest = { url, init };
      return new Response(JSON.stringify({
        id: "bps_01rocky",
        url: "https://billing.stripe.com/p/session/test_rocky"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    },
    async () => ({ authenticated: true, userId: "user_rocky" })
  );

  assert.equal(result.status, 200);
  assert.equal(
    result.body.portalUrl,
    "https://billing.stripe.com/p/session/test_rocky"
  );
  assert.equal(
    stripeRequest.url,
    "https://api.stripe.com/v1/billing_portal/sessions"
  );
  assert.equal(
    stripeRequest.init.headers.Authorization,
    "Bearer sk_test_not-a-real-key"
  );
  const form = new URLSearchParams(stripeRequest.init.body);
  assert.equal(form.get("customer"), "cus_01rocky");
  assert.equal(form.get("return_url"), "https://www.rockyaloha.com/");
});

test("billing portal requires sign-in and a linked Stripe customer", async () => {
  const request = new Request(
    "https://www.rockyaloha.com/create-billing-portal-session",
    { method: "POST" }
  );
  const noIdentity = await createStripeBillingPortal(
    request,
    makeEnv(),
    async () => {
      throw new Error("Stripe must not be called");
    },
    async () => ({ authenticated: false })
  );
  const noCustomer = await createStripeBillingPortal(
    new Request(request),
    makeEnv(),
    async () => {
      throw new Error("Stripe must not be called");
    },
    async () => ({ authenticated: true, userId: "user_free" })
  );

  assert.equal(noIdentity.status, 401);
  assert.deepEqual(noIdentity.body, { error: "sign_in_required" });
  assert.equal(noCustomer.status, 404);
  assert.deepEqual(noCustomer.body, { error: "billing_account_not_found" });
});

test("verified subscription events grant Plus and are idempotent", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const event = subscriptionEvent();

  const first = await processStripeEvent(env, event);
  const second = await processStripeEvent(env, event);

  assert.equal(first.updated, true);
  assert.equal(second.duplicate, true);
  assert.deepEqual(db.entitlements.get("user_rocky"), {
    plan: "plus",
    status: "active",
    currentPeriodEnd: "2026-08-17T12:00:00.000Z",
    createdAt: db.entitlements.get("user_rocky").createdAt,
    updatedAt: db.entitlements.get("user_rocky").updatedAt,
    subscriptionId: "sub_01rocky",
    customerId: "cus_01rocky",
    priceId: "price_month",
    lastEventAt: "2026-07-17T12:00:00.000Z"
  });
});

test("stored subscription identity survives missing webhook metadata", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  await processStripeEvent(env, subscriptionEvent());

  const canceled = subscriptionEvent({
    eventId: "evt_02canceled",
    eventType: "customer.subscription.deleted",
    status: "canceled",
    created: Date.parse("2026-07-18T12:00:00.000Z") / 1000,
    includeMetadata: false
  });
  canceled.data.object.items.data[0].current_period_end = null;

  const result = await processStripeEvent(env, canceled);

  assert.equal(result.updated, true);
  assert.equal(result.userId, "user_rocky");
  assert.equal(db.entitlements.get("user_rocky").status, "canceled");
  assert.equal(db.entitlements.get("user_rocky").currentPeriodEnd, null);
});

test("events with an untrusted identity or price do not grant Plus", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const untrustedIdentity = subscriptionEvent({ userId: "not-a-clerk-user" });
  const untrustedPrice = subscriptionEvent({
    eventId: "evt_02wrongprice",
    priceId: "price_not_rocky"
  });

  const identityResult = await processStripeEvent(env, untrustedIdentity);
  const priceResult = await processStripeEvent(env, untrustedPrice);

  assert.equal(identityResult.updated, false);
  assert.equal(priceResult.updated, false);
  assert.equal(db.entitlements.size, 0);
});

test("webhook handler verifies the raw body before updating entitlements", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const now = new Date("2026-07-17T12:00:00.000Z");
  const event = subscriptionEvent();
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = await stripeSignature(
    env.STRIPE_WEBHOOK_SECRET,
    timestamp,
    rawBody
  );
  const request = new Request("https://www.rockyaloha.com/stripe-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature
    },
    body: rawBody
  });

  const response = await handleStripeWebhook(request, env, now);

  assert.equal(response.status, 200);
  assert.equal(response.body.updated, true);
  assert.equal(db.entitlements.get("user_rocky").plan, "plus");
});

test("webhook keeps processing cancellations while new checkout is disabled", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  await processStripeEvent(env, subscriptionEvent());
  env.ROCKY_PAYMENTS_ENABLED = "false";

  const now = new Date("2026-07-18T12:00:00.000Z");
  const event = subscriptionEvent({
    eventId: "evt_02disabled",
    eventType: "customer.subscription.deleted",
    status: "canceled",
    created: Math.floor(now.getTime() / 1000),
    includeMetadata: false
  });
  event.data.object.items.data[0].current_period_end = null;
  const rawBody = JSON.stringify(event);
  const signature = await stripeSignature(
    env.STRIPE_WEBHOOK_SECRET,
    Math.floor(now.getTime() / 1000),
    rawBody
  );
  const request = new Request("https://www.rockyaloha.com/stripe-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature
    },
    body: rawBody
  });

  const response = await handleStripeWebhook(request, env, now);

  assert.equal(response.status, 200);
  assert.equal(response.body.updated, true);
  assert.equal(db.entitlements.get("user_rocky").status, "canceled");
});
