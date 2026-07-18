import test from "node:test";
import assert from "node:assert/strict";

import {
  accessPlanForEnvironment,
  accessPlanFor,
  bearerTokenFrom,
  consumeIdentityAllowance,
  FREE_DAILY_LIMIT,
  getIdentityAccess,
  identityConfiguration,
  PLUS_DAILY_LIMIT,
  refundIdentityAllowance,
  SANDBOX_FREE_DAILY_LIMIT
} from "../WEBSITE/functions/identity.js";

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

  async run() {
    if (this.sql.includes("INSERT OR IGNORE INTO users")) {
      const [userId, createdAt, updatedAt] = this.params;
      if (!this.db.users.has(userId)) {
        this.db.users.set(userId, { createdAt, updatedAt });
      }
    }

    if (this.sql.includes("INSERT OR IGNORE INTO entitlements")) {
      const [userId] = this.params;
      if (!this.db.entitlements.has(userId)) {
        this.db.entitlements.set(userId, {
          plan: "free",
          status: "active",
          source: "signup",
          current_period_end: null
        });
      }
    }

    return { success: true };
  }

  async first() {
    if (this.sql.includes("FROM entitlements")) {
      return this.db.entitlements.get(this.params[0]) || null;
    }

    if (this.sql.includes("FROM usage_daily")) {
      const key = `${this.params[0]}:${this.params[1]}`;
      const answerCount = this.db.usage.get(key);
      return answerCount === undefined ? null : { answer_count: answerCount };
    }

    if (this.sql.includes("INSERT INTO usage_daily")) {
      const [userId, utcDay, , limit] = this.params;
      const key = `${userId}:${utcDay}`;
      const current = this.db.usage.get(key) || 0;
      if (current >= limit) return null;
      const next = current + 1;
      this.db.usage.set(key, next);
      return { answer_count: next };
    }

    if (this.sql.includes("UPDATE usage_daily")) {
      const [, userId, utcDay] = this.params;
      const key = `${userId}:${utcDay}`;
      const current = this.db.usage.get(key) || 0;
      if (current <= 0) return null;
      const next = current - 1;
      this.db.usage.set(key, next);
      return { answer_count: next };
    }

    throw new Error(`Unexpected SQL: ${this.sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.users = new Map();
    this.entitlements = new Map();
    this.usage = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
  }
}

test("identity configuration stays off until every required binding exists", () => {
  assert.deepEqual(identityConfiguration({ ROCKY_IDENTITY_ENABLED: "false" }), {
    enabled: false,
    ready: false,
    publishableKey: ""
  });

  assert.deepEqual(identityConfiguration({
    ROCKY_IDENTITY_ENABLED: "true",
    CLERK_PUBLISHABLE_KEY: "pk_test_value",
    CLERK_JWT_KEY: "public-key",
    ROCKY_DB: {}
  }), {
    enabled: true,
    ready: true,
    publishableKey: "pk_test_value"
  });
});

test("extracts only a correctly formed Bearer token", () => {
  const valid = new Request("https://www.rockyaloha.com/me", {
    headers: { Authorization: "Bearer session-token" }
  });
  const invalid = new Request("https://www.rockyaloha.com/me", {
    headers: { Authorization: "Basic session-token" }
  });

  assert.equal(bearerTokenFrom(valid), "session-token");
  assert.equal(bearerTokenFrom(invalid), "");
});

test("resolves active and expired Plus entitlements", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const active = accessPlanFor({
    plan: "plus",
    status: "active",
    current_period_end: "2026-08-16T12:00:00.000Z"
  }, now);
  const expired = accessPlanFor({
    plan: "plus",
    status: "active",
    current_period_end: "2026-06-16T12:00:00.000Z"
  }, now);

  assert.deepEqual(active, { plan: "plus", dailyLimit: PLUS_DAILY_LIMIT });
  assert.deepEqual(expired, { plan: "free", dailyLimit: FREE_DAILY_LIMIT });
});

test("immediate cancellations return Free while scheduled cancellations retain Plus", () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const immediate = accessPlanFor({
    plan: "plus",
    status: "canceled",
    current_period_end: null
  }, now);
  const scheduled = accessPlanFor({
    plan: "plus",
    status: "canceled",
    current_period_end: "2026-08-16T12:00:00.000Z"
  }, now);

  assert.deepEqual(immediate, { plan: "free", dailyLimit: FREE_DAILY_LIMIT });
  assert.deepEqual(scheduled, { plan: "plus", dailyLimit: PLUS_DAILY_LIMIT });
});

test("sandbox Free accounts get a testing allowance without changing production", () => {
  const entitlement = {
    plan: "free",
    status: "active",
    current_period_end: null
  };

  assert.deepEqual(
    accessPlanForEnvironment(
      { PADDLE_ENVIRONMENT: "sandbox" },
      entitlement
    ),
    { plan: "free", dailyLimit: SANDBOX_FREE_DAILY_LIMIT }
  );
  assert.deepEqual(
    accessPlanForEnvironment(
      { PADDLE_ENVIRONMENT: "production" },
      entitlement
    ),
    { plan: "free", dailyLimit: FREE_DAILY_LIMIT }
  );
});

test("D1 enforces the Free daily account allowance atomically", async () => {
  const db = new FakeD1();
  const env = { ROCKY_DB: db };
  const now = new Date("2026-07-16T12:00:00.000Z");

  const first = await consumeIdentityAllowance(env, "user_free", now);
  const second = await consumeIdentityAllowance(env, "user_free", now);

  assert.equal(first.allowed, true);
  assert.equal(first.access.remaining, 0);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "account_daily_limit");
});

test("D1 lets an existing sandbox Free account continue testing", async () => {
  const db = new FakeD1();
  const now = new Date("2026-07-16T12:00:00.000Z");
  db.usage.set("user_staging:2026-07-16", 1);

  const decision = await consumeIdentityAllowance(
    { ROCKY_DB: db, PADDLE_ENVIRONMENT: "sandbox" },
    "user_staging",
    now
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.access.plan, "free");
  assert.equal(decision.access.dailyLimit, SANDBOX_FREE_DAILY_LIMIT);
  assert.equal(decision.access.used, 2);
  assert.equal(decision.access.remaining, SANDBOX_FREE_DAILY_LIMIT - 2);
});

test("D1 gives an active Plus account twenty answers per day", async () => {
  const db = new FakeD1();
  db.entitlements.set("user_plus", {
    plan: "plus",
    status: "active",
    source: "manual",
    current_period_end: null
  });

  const decision = await consumeIdentityAllowance(
    { ROCKY_DB: db },
    "user_plus",
    new Date("2026-07-16T12:00:00.000Z")
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.access.dailyLimit, PLUS_DAILY_LIMIT);
  assert.equal(decision.access.remaining, PLUS_DAILY_LIMIT - 1);
});

test("identity access exposes only a valid Paddle customer ID for Retain", async () => {
  const db = new FakeD1();
  db.entitlements.set("user_plus", {
    plan: "plus",
    status: "active",
    source: "paddle",
    current_period_end: null,
    paddle_customer_id: "ctm_01rocky"
  });

  const access = await getIdentityAccess(
    { ROCKY_DB: db },
    "user_plus",
    new Date("2026-07-16T12:00:00.000Z")
  );

  assert.equal(access.paddleCustomerId, "ctm_01rocky");
});

test("D1 refunds an answer when the provider fails", async () => {
  const db = new FakeD1();
  const env = { ROCKY_DB: db };
  const now = new Date("2026-07-16T12:00:00.000Z");

  await consumeIdentityAllowance(env, "user_refund", now);
  const access = await refundIdentityAllowance(env, "user_refund", now);

  assert.equal(access.used, 0);
  assert.equal(access.remaining, 1);
});
