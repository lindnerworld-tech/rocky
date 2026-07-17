import test from "node:test";
import assert from "node:assert/strict";

import {
  checkoutContext,
  createCheckoutContext,
  handlePaddleWebhook,
  paymentsConfiguration,
  processPaddleEvent,
  verifyPaddleSignature
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
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_CLIENT_TOKEN: "test_public",
    PADDLE_MONTHLY_PRICE_ID: "pri_month",
    PADDLE_ANNUAL_PRICE_ID: "pri_year",
    PADDLE_WEBHOOK_SECRET: "webhook-secret"
  };
}

async function paddleSignature(secret, timestamp, rawBody) {
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
    new TextEncoder().encode(`${timestamp}:${rawBody}`)
  );
  const hex = Array.from(new Uint8Array(signature), byte =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `ts=${timestamp};h1=${hex}`;
}

async function subscriptionEvent({
  eventId = "evt_01test",
  eventType = "subscription.created",
  status = "active",
  occurredAt = "2026-07-17T12:00:00.000Z",
  priceId = "pri_month",
  secret = "webhook-secret",
  userId = "user_rocky"
} = {}) {
  return {
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    data: {
      id: "sub_01rocky",
      customer_id: "ctm_01rocky",
      status,
      current_billing_period: {
        ends_at: "2026-08-17T12:00:00.000Z"
      },
      items: [{ price: { id: priceId } }],
      custom_data: await createCheckoutContext(userId, secret)
    }
  };
}

test("payments configuration exposes only public checkout values", () => {
  const config = paymentsConfiguration(makeEnv());
  assert.deepEqual(config, {
    enabled: true,
    ready: true,
    environment: "sandbox",
    clientToken: "test_public",
    monthlyPriceId: "pri_month",
    annualPriceId: "pri_year"
  });
  assert.equal("webhookSecret" in config, false);
});

test("Paddle signature verification rejects changed and stale payloads", async () => {
  const rawBody = JSON.stringify({ event_id: "evt_01test" });
  const now = new Date("2026-07-17T12:00:00.000Z");
  const timestamp = Math.floor(now.getTime() / 1000);
  const header = await paddleSignature("webhook-secret", timestamp, rawBody);

  assert.equal(
    await verifyPaddleSignature(rawBody, header, "webhook-secret", now),
    true
  );
  assert.equal(
    await verifyPaddleSignature(`${rawBody} `, header, "webhook-secret", now),
    false
  );
  assert.equal(
    await verifyPaddleSignature(
      rawBody,
      header,
      "webhook-secret",
      new Date("2026-07-17T12:10:00.000Z")
    ),
    false
  );
});

test("checkout context requires a signed-in Rocky account", async () => {
  const env = makeEnv();
  const request = new Request("https://rocky.test/paddle-checkout-context");
  const signedOut = await checkoutContext(request, env, async () => ({
    authenticated: false
  }));
  const signedIn = await checkoutContext(request, env, async () => ({
    authenticated: true,
    userId: "user_rocky"
  }));

  assert.equal(signedOut.status, 401);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.clerk_user_id, "user_rocky");
  assert.match(signedIn.body.rocky_checkout_signature, /^[a-f0-9]{64}$/);
});

test("verified subscription events grant Plus and are idempotent", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const event = await subscriptionEvent();

  const first = await processPaddleEvent(env, event);
  const second = await processPaddleEvent(env, event);

  assert.equal(first.updated, true);
  assert.equal(second.duplicate, true);
  assert.deepEqual(db.entitlements.get("user_rocky"), {
    plan: "plus",
    status: "active",
    currentPeriodEnd: "2026-08-17T12:00:00.000Z",
    createdAt: db.entitlements.get("user_rocky").createdAt,
    updatedAt: db.entitlements.get("user_rocky").updatedAt,
    subscriptionId: "sub_01rocky",
    customerId: "ctm_01rocky",
    priceId: "pri_month",
    lastEventAt: "2026-07-17T12:00:00.000Z"
  });
});

test("events with an untrusted checkout identity do not grant Plus", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const event = await subscriptionEvent();
  event.data.custom_data.rocky_checkout_signature = "0".repeat(64);

  const result = await processPaddleEvent(env, event);

  assert.equal(result.updated, false);
  assert.equal(db.entitlements.size, 0);
});

test("webhook handler verifies the raw body before updating entitlements", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const now = new Date("2026-07-17T12:00:00.000Z");
  const event = await subscriptionEvent();
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(now.getTime() / 1000);
  const signature = await paddleSignature(
    env.PADDLE_WEBHOOK_SECRET,
    timestamp,
    rawBody
  );
  const request = new Request("https://rocky.test/paddle-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Paddle-Signature": signature
    },
    body: rawBody
  });

  const response = await handlePaddleWebhook(request, env, now);

  assert.equal(response.status, 200);
  assert.equal(response.body.updated, true);
  assert.equal(db.entitlements.get("user_rocky").plan, "plus");
});

