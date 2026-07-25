import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  creatorShareUrl,
  creatorsConfiguration,
  handleCreatorApplication,
  handleCreatorEvent,
  recordCreatorReferral,
  validReferralCode
} from "../WEBSITE/functions/creators.js";

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
    if (this.sql.includes("INSERT INTO creator_applications")) {
      const [
        applicationId,
        name,
        email,
        platform,
        profileUrl,
        audienceRange,
        message,
        referralCode,
        source,
        campaign,
        consentAt,
        createdAt,
        updatedAt
      ] = this.params;
      const existing = this.db.applicationsByEmail.get(email);
      if (existing) {
        Object.assign(existing, {
          name,
          platform,
          profileUrl,
          audienceRange,
          message,
          source,
          campaign,
          consentAt,
          updatedAt
        });
        return {
          application_id: existing.applicationId,
          referral_code: existing.referralCode
        };
      }
      const application = {
        applicationId,
        status: "new",
        name,
        email,
        platform,
        profileUrl,
        audienceRange,
        message,
        referralCode,
        source,
        campaign,
        consentAt,
        createdAt,
        updatedAt
      };
      this.db.applicationsByEmail.set(email, application);
      this.db.applicationsByCode.set(referralCode, application);
      return {
        application_id: applicationId,
        referral_code: referralCode
      };
    }

    if (this.sql.includes("FROM creator_applications")) {
      const application = this.db.applicationsByCode.get(this.params[0]);
      if (!application || application.status === "declined") return null;
      return { referral_code: application.referralCode };
    }

    throw new Error(`Unexpected first SQL: ${this.sql}`);
  }

  async run() {
    if (this.sql.includes("INSERT INTO creator_daily_events")) {
      const [
        eventDate,
        eventName,
        referralCode,
        source,
        campaign,
        updatedAt
      ] = this.params;
      const key = [
        eventDate,
        eventName,
        referralCode,
        source,
        campaign
      ].join("|");
      const existing = this.db.events.get(key);
      this.db.events.set(key, {
        eventDate,
        eventName,
        referralCode,
        source,
        campaign,
        count: (existing?.count || 0) + 1,
        updatedAt
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.includes("INSERT INTO creator_referrals")) {
      const [
        subscriptionId,
        userId,
        referralCode,
        status,
        eventId,
        occurredAt,
        createdAt,
        updatedAt
      ] = this.params;
      this.db.referrals.set(subscriptionId, {
        subscriptionId,
        userId,
        referralCode,
        status,
        eventId,
        occurredAt,
        createdAt,
        updatedAt
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (this.sql.includes("UPDATE creator_referrals")) {
      const [
        status,
        eventId,
        occurredAt,
        updatedAt,
        subscriptionId
      ] = this.params;
      const referral = this.db.referrals.get(subscriptionId);
      if (referral) {
        Object.assign(referral, {
          status,
          eventId,
          occurredAt,
          updatedAt
        });
      }
      return {
        success: true,
        meta: { changes: referral ? 1 : 0 }
      };
    }

    throw new Error(`Unexpected run SQL: ${this.sql}`);
  }
}

class FakeD1 {
  constructor() {
    this.applicationsByEmail = new Map();
    this.applicationsByCode = new Map();
    this.events = new Map();
    this.referrals = new Map();
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

function successfulLimiter() {
  return {
    async limit() {
      return { success: true };
    }
  };
}

function makeEnv(db = new FakeD1()) {
  return {
    ROCKY_CREATORS_ENABLED: "true",
    ROCKY_SITE_URL: "https://www.rockyaloha.com",
    ROCKY_DB: db,
    TURNSTILE_SITE_KEY: "site-test",
    TURNSTILE_SECRET_KEY: "secret-test",
    IP_RATE_LIMITER: successfulLimiter(),
    GLOBAL_RATE_LIMITER: successfulLimiter()
  };
}

function creatorRequest(overrides = {}) {
  return new Request("https://www.rockyaloha.com/creator-apply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10"
    },
    body: JSON.stringify({
      name: "Island Storyteller",
      email: "creator@example.com",
      platform: "youtube",
      profileUrl: "https://www.youtube.com/@islandstoryteller",
      audienceRange: "10k-50k",
      message: "My audience values thoughtful stories about perspective and place.",
      website: "",
      consent: true,
      turnstileToken: "valid-token",
      source: "instagram",
      campaign: "founding20",
      ...overrides
    })
  });
}

async function validTurnstile(url, init) {
  assert.equal(
    url,
    "https://challenges.cloudflare.com/turnstile/v0/siteverify"
  );
  const payload = JSON.parse(init.body);
  assert.equal(payload.secret, "secret-test");
  assert.equal(payload.response, "valid-token");
  return new Response(JSON.stringify({
    success: true,
    action: "creator_apply",
    hostname: "www.rockyaloha.com"
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("creator configuration exposes readiness without secret values", () => {
  assert.deepEqual(creatorsConfiguration(makeEnv()), {
    enabled: true,
    ready: true,
    program: "founding20"
  });
  const serialized = JSON.stringify(creatorsConfiguration(makeEnv()));
  assert.equal(serialized.includes("secret-test"), false);
  assert.equal(creatorsConfiguration({
    ROCKY_CREATORS_ENABLED: "false"
  }).ready, false);
});

test("creator application is protected, stored, and returns a personal link", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const uuids = [
    "11111111-1111-4111-8111-111111111111",
    "abcdef12-3456-4789-8123-123456789abc"
  ];
  const result = await handleCreatorApplication(
    creatorRequest(),
    env,
    {
      fetcher: validTurnstile,
      now: new Date("2026-07-25T22:00:00.000Z"),
      randomUUID: () => uuids.shift()
    }
  );

  assert.equal(result.status, 201);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.applicationId, "creator_11111111111141118111111111111111");
  assert.equal(result.body.referralCode, "rocky-island-storyteller-abcdef");
  assert.equal(
    result.body.shareUrl,
    "https://www.rockyaloha.com/?ref=rocky-island-storyteller-abcdef&utm_source=creator&utm_medium=referral&utm_campaign=founding20"
  );
  assert.equal(db.applicationsByEmail.size, 1);
  assert.equal(
    db.applicationsByEmail.get("creator@example.com").message,
    "My audience values thoughtful stories about perspective and place."
  );
  assert.equal("turnstileToken" in db.applicationsByEmail.get("creator@example.com"), false);
});

test("repeat application keeps the original referral code", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const firstUuids = [
    "11111111-1111-4111-8111-111111111111",
    "abcdef12-3456-4789-8123-123456789abc"
  ];
  const secondUuids = [
    "22222222-2222-4222-8222-222222222222",
    "fedcba98-7654-4321-8987-987654321abc"
  ];

  const first = await handleCreatorApplication(
    creatorRequest(),
    env,
    { fetcher: validTurnstile, randomUUID: () => firstUuids.shift() }
  );
  const second = await handleCreatorApplication(
    creatorRequest({
      message: "Updated application with more context for the Rocky launch."
    }),
    env,
    { fetcher: validTurnstile, randomUUID: () => secondUuids.shift() }
  );

  assert.equal(second.status, 201);
  assert.equal(second.body.applicationId, first.body.applicationId);
  assert.equal(second.body.referralCode, first.body.referralCode);
  assert.equal(db.applicationsByEmail.size, 1);
});

test("creator application rejects invalid fields and failed verification", async () => {
  const invalid = await handleCreatorApplication(
    creatorRequest({ email: "not-an-email" }),
    makeEnv(),
    { fetcher: validTurnstile }
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "invalid_creator_application");

  const failedVerification = await handleCreatorApplication(
    creatorRequest(),
    makeEnv(),
    {
      fetcher: async () => new Response(JSON.stringify({
        success: false,
        action: "creator_apply",
        hostname: "www.rockyaloha.com"
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    }
  );
  assert.equal(failedVerification.status, 403);
  assert.equal(failedVerification.body.error, "creator_verification_failed");
});

test("honeypot submission is accepted without storing applicant data", async () => {
  const db = new FakeD1();
  const result = await handleCreatorApplication(
    creatorRequest({ website: "https://spam.example" }),
    makeEnv(db),
    {
      fetcher: async () => {
        throw new Error("Turnstile should not be called for a bot");
      }
    }
  );

  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(db.applicationsByEmail.size, 0);
});

test("creator events aggregate counts without storing visitor identity", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const request = () => new Request(
    "https://www.rockyaloha.com/creator-event",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.10"
      },
      body: JSON.stringify({
        event: "share_clicked",
        referralCode: "rocky-island-storyteller-abcdef",
        source: "youtube",
        campaign: "founding20"
      })
    }
  );

  assert.equal((await handleCreatorEvent(
    request(),
    env,
    { now: new Date("2026-07-25T22:00:00.000Z") }
  )).status, 202);
  assert.equal((await handleCreatorEvent(
    request(),
    env,
    { now: new Date("2026-07-25T22:01:00.000Z") }
  )).status, 202);

  assert.equal(db.events.size, 1);
  const event = [...db.events.values()][0];
  assert.equal(event.count, 2);
  assert.equal("email" in event, false);
  assert.equal("ip" in event, false);
});

test("confirmed Stripe referral is recorded only for a known creator code", async () => {
  const db = new FakeD1();
  const application = {
    status: "active",
    referralCode: "rocky-island-storyteller-abcdef"
  };
  db.applicationsByCode.set(application.referralCode, application);
  const env = makeEnv(db);

  const tracked = await recordCreatorReferral(env, {
    subscriptionId: "sub_rocky",
    userId: "user_rocky",
    referralCode: application.referralCode,
    status: "active",
    eventId: "evt_rocky",
    occurredAt: "2026-07-25T22:00:00.000Z",
    receivedAt: "2026-07-25T22:00:01.000Z"
  });
  const ignored = await recordCreatorReferral(env, {
    subscriptionId: "sub_unknown",
    userId: "user_unknown",
    referralCode: "rocky-unknown-123456",
    status: "active",
    eventId: "evt_unknown",
    occurredAt: "2026-07-25T22:00:00.000Z",
    receivedAt: "2026-07-25T22:00:01.000Z"
  });

  assert.equal(tracked, true);
  assert.equal(ignored, false);
  assert.equal(db.referrals.size, 1);
  assert.equal(
    db.referrals.get("sub_rocky").referralCode,
    application.referralCode
  );
});

test("creator page, homepage, and migration provide the full protected funnel", async () => {
  const [creatorPage, homepage, privacy, terms, migration, worker, config] =
    await Promise.all([
      readFile(new URL("../WEBSITE/creators.html", import.meta.url), "utf8"),
      readFile(new URL("../WEBSITE/index.html", import.meta.url), "utf8"),
      readFile(new URL("../WEBSITE/privacy.html", import.meta.url), "utf8"),
      readFile(new URL("../WEBSITE/terms.html", import.meta.url), "utf8"),
      readFile(
        new URL("../migrations/0005_creator_launch.sql", import.meta.url),
        "utf8"
      ),
      readFile(new URL("../worker.mjs", import.meta.url), "utf8"),
      readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
    ]);

  assert.match(creatorPage, /Founding 20 Creator Circle/);
  assert.match(creatorPage, /fetch\("\/creator-apply"/);
  assert.match(creatorPage, /fetch\("\/creator-event"/);
  assert.match(creatorPage, /action: "creator_apply"/);
  assert.match(creatorPage, /navigator\.share/);
  assert.match(creatorPage, /ftc\.gov\/influencers/);
  assert.match(creatorPage, /property="og:title"/);
  assert.match(homepage, /id="creatorInvite" hidden/);
  assert.match(homepage, /referralCode: attribution\.referralCode/);
  assert.match(homepage, /property="og:title"/);
  assert.match(homepage, /application\/ld\+json/);
  assert.match(privacy, /Creator applications and referrals/);
  assert.match(terms, /Creator Circle and referral links/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS creator_applications/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS creator_daily_events/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS creator_referrals/);
  assert.doesNotMatch(migration, /ip_address|raw_ip/i);
  assert.match(worker, /url\.pathname === "\/creator-apply"/);
  assert.match(worker, /url\.pathname === "\/creator-event"/);
  assert.match(config, /"ROCKY_CREATORS_ENABLED": "false"/);
  assert.match(config, /"ROCKY_CREATORS_ENABLED": "true"/);
  assert.doesNotMatch(creatorPage, /TURNSTILE_SECRET_KEY|STRIPE_SECRET_KEY/);
});

test("referral codes and share URLs fail closed on malformed input", () => {
  assert.equal(validReferralCode("Rocky-Creator_123"), "rocky-creator_123");
  assert.equal(validReferralCode("../../admin"), "");
  assert.equal(validReferralCode("x"), "");
  assert.equal(
    creatorShareUrl(
      new Request("https://www.rockyaloha.com/creators"),
      { ROCKY_SITE_URL: "https://www.rockyaloha.com" },
      "rocky-creator_123"
    ),
    "https://www.rockyaloha.com/?ref=rocky-creator_123&utm_source=creator&utm_medium=referral&utm_campaign=founding20"
  );
});
