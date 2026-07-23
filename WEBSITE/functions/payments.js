import {
  authenticateRequestIdentity,
  getIdentityAccess
} from "./identity.js";

const MAX_CHECKOUT_BODY_BYTES = 4 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const STRIPE_API_VERSION = "2025-03-31.basil";
const STRIPE_SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.updated"
]);

const textEncoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(value)
  );
  return bytesToHex(new Uint8Array(signature));
}

function parsedStripeSignature(header) {
  const values = {};
  for (const part of String(header || "").split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    if (!values[name]) values[name] = [];
    values[name].push(value);
  }
  return {
    timestamp: Number(values.t?.[0]),
    signatures: values.v1 || []
  };
}

function validClerkUserId(userId) {
  return /^user_[A-Za-z0-9]+$/.test(String(userId || ""));
}

function checkoutBaseUrl(request, env) {
  const configured = String(env.ROCKY_SITE_URL || "").trim();
  const fallback = new URL(request.url).origin;
  const base = new URL(configured || fallback);
  if (base.protocol !== "https:" && base.hostname !== "localhost") {
    throw new Error("Checkout return URL must use HTTPS");
  }
  return base;
}

function acceptedPriceForPlan(env, plan) {
  if (plan === "monthly") return env.STRIPE_MONTHLY_PRICE_ID || "";
  if (plan === "annual") return env.STRIPE_ANNUAL_PRICE_ID || "";
  return "";
}

function checkoutUrlFromStripe(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      (url.hostname === "checkout.stripe.com" || url.hostname.endsWith(".stripe.com"))
    ) {
      return url.toString();
    }
  } catch {
    // The caller converts this to a safe upstream error.
  }
  return "";
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function stripeId(value, prefix) {
  const id = typeof value === "string" ? value : value?.id;
  return String(id || "").startsWith(prefix) ? String(id) : "";
}

export function paymentsConfiguration(env) {
  const enabled = env.ROCKY_PAYMENTS_ENABLED === "true";
  const ready = Boolean(
    enabled &&
    env.STRIPE_SECRET_KEY &&
    env.STRIPE_WEBHOOK_SECRET &&
    env.STRIPE_MONTHLY_PRICE_ID &&
    env.STRIPE_ANNUAL_PRICE_ID &&
    env.ROCKY_DB
  );

  return {
    enabled,
    ready,
    provider: "stripe",
    checkout: "hosted"
  };
}

export async function verifyStripeSignature(
  rawBody,
  signatureHeader,
  secret,
  now = new Date()
) {
  if (!rawBody || !signatureHeader || !secret) return false;

  const { timestamp, signatures } = parsedStripeSignature(signatureHeader);
  if (!Number.isInteger(timestamp) || signatures.length === 0) return false;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  return signatures.some(signature => safeEqual(signature, expected));
}

export async function createStripeCheckout(
  request,
  env,
  fetchStripe = fetch,
  resolveIdentity = authenticateRequestIdentity,
  resolveAccess = getIdentityAccess
) {
  if (request.method !== "POST") {
    return {
      status: 405,
      body: { error: "method_not_allowed" },
      headers: { Allow: "POST" }
    };
  }

  const config = paymentsConfiguration(env);
  if (!config.enabled || !config.ready) {
    return { status: 503, body: { error: "payments_not_configured" } };
  }

  const identity = await resolveIdentity(request, env);
  if (!identity.authenticated) {
    return { status: 401, body: { error: "sign_in_required" } };
  }

  try {
    const access = await resolveAccess(env, identity.userId);
    if (access.plan === "plus") {
      return { status: 409, body: { error: "already_plus" } };
    }
  } catch {
    return { status: 503, body: { error: "identity_store_unavailable" } };
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_CHECKOUT_BODY_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  let payload;
  try {
    const rawBody = await request.text();
    if (textEncoder.encode(rawBody).byteLength > MAX_CHECKOUT_BODY_BYTES) {
      return { status: 413, body: { error: "payload_too_large" } };
    }
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  const plan = String(payload?.plan || "");
  const priceId = acceptedPriceForPlan(env, plan);
  if (!priceId) {
    return { status: 400, body: { error: "invalid_plan" } };
  }

  let baseUrl;
  try {
    baseUrl = checkoutBaseUrl(request, env);
  } catch {
    return { status: 503, body: { error: "payments_not_configured" } };
  }

  const form = new URLSearchParams();
  form.set("line_items[0][price]", priceId);
  form.set("line_items[0][quantity]", "1");
  form.set("managed_payments[enabled]", "true");
  form.set("mode", "subscription");
  form.set("success_url", new URL("/?checkout=success", baseUrl).toString());
  form.set("cancel_url", new URL("/?checkout=canceled", baseUrl).toString());
  form.set("client_reference_id", identity.userId);
  form.set("metadata[rocky_user_id]", identity.userId);
  form.set("metadata[rocky_plan]", plan);
  form.set("subscription_data[metadata][rocky_user_id]", identity.userId);
  form.set("subscription_data[metadata][rocky_plan]", plan);

  let response;
  try {
    response = await fetchStripe("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": STRIPE_API_VERSION
      },
      body: form.toString()
    });
  } catch {
    return { status: 502, body: { error: "checkout_unavailable" } };
  }

  let session;
  try {
    session = await response.json();
  } catch {
    return { status: 502, body: { error: "checkout_unavailable" } };
  }

  const checkoutUrl = response.ok ? checkoutUrlFromStripe(session?.url) : "";
  if (!checkoutUrl) {
    return { status: 502, body: { error: "checkout_unavailable" } };
  }

  return {
    status: 200,
    body: {
      checkoutUrl
    }
  };
}

function mappedEntitlementStatus(status) {
  if (status === "active") return "active";
  if (status === "trialing") return "trialing";
  if (status === "past_due") return "past_due";
  if (status === "canceled") return "canceled";
  return "expired";
}

async function markEventProcessed(db, eventId, userId, processedAt) {
  await db.prepare(
    `UPDATE entitlement_events
     SET user_id = ?, processed_at = ?
     WHERE event_id = ?`
  ).bind(userId || null, processedAt, eventId).run();
}

async function userIdForSubscription(db, subscriptionId) {
  if (!subscriptionId) return "";
  const row = await db.prepare(
    `SELECT user_id
     FROM entitlements
     WHERE stripe_subscription_id = ?`
  ).bind(subscriptionId).first();
  return String(row?.user_id || "");
}

function currentPeriodEndFor(subscription, acceptedPriceId) {
  const itemEnds = (subscription?.items?.data || [])
    .filter(item => item?.price?.id === acceptedPriceId)
    .map(item => Number(item?.current_period_end))
    .filter(value => Number.isFinite(value) && value > 0);

  if (itemEnds.length > 0) {
    return unixSecondsToIso(Math.max(...itemEnds));
  }
  return unixSecondsToIso(subscription?.current_period_end);
}

export async function processStripeEvent(env, event, now = new Date()) {
  if (!env.ROCKY_DB) throw new Error("ROCKY_DB is not configured");

  const eventId = String(event?.id || "");
  const eventType = String(event?.type || "");
  const eventCreated = Number(event?.created);
  if (
    !/^evt_[A-Za-z0-9]+$/.test(eventId) ||
    !eventType ||
    !Number.isFinite(eventCreated)
  ) {
    throw new Error("Invalid Stripe event");
  }

  const receivedAt = now.toISOString();
  await env.ROCKY_DB.prepare(
    `INSERT OR IGNORE INTO entitlement_events
     (event_id, provider, event_type, user_id, received_at, processed_at)
     VALUES (?, 'stripe', ?, NULL, ?, NULL)`
  ).bind(eventId, eventType, receivedAt).run();

  const existing = await env.ROCKY_DB.prepare(
    `SELECT processed_at FROM entitlement_events WHERE event_id = ?`
  ).bind(eventId).first();
  if (existing?.processed_at) return { duplicate: true, updated: false };

  if (!STRIPE_SUBSCRIPTION_EVENTS.has(eventType)) {
    await markEventProcessed(env.ROCKY_DB, eventId, "", receivedAt);
    return { duplicate: false, updated: false };
  }

  const subscription = event?.data?.object;
  const subscriptionId = stripeId(subscription?.id, "sub_");
  let userId = await userIdForSubscription(env.ROCKY_DB, subscriptionId);
  if (!userId && validClerkUserId(subscription?.metadata?.rocky_user_id)) {
    userId = subscription.metadata.rocky_user_id;
  }
  if (!subscriptionId || !userId) {
    await markEventProcessed(env.ROCKY_DB, eventId, "", receivedAt);
    return { duplicate: false, updated: false };
  }

  const acceptedPrices = new Set([
    env.STRIPE_MONTHLY_PRICE_ID,
    env.STRIPE_ANNUAL_PRICE_ID
  ].filter(Boolean));
  const priceId = (subscription?.items?.data || [])
    .map(item => item?.price?.id)
    .find(candidate => acceptedPrices.has(candidate));

  if (!priceId) {
    await markEventProcessed(env.ROCKY_DB, eventId, userId, receivedAt);
    return { duplicate: false, updated: false };
  }

  const status = mappedEntitlementStatus(subscription?.status);
  const currentPeriodEnd = status === "canceled"
    ? null
    : currentPeriodEndFor(subscription, priceId);
  const customerId = stripeId(subscription?.customer, "cus_");
  const occurredAt = unixSecondsToIso(eventCreated);

  await env.ROCKY_DB.batch([
    env.ROCKY_DB.prepare(
      `INSERT OR IGNORE INTO users (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?)`
    ).bind(userId, receivedAt, receivedAt),
    env.ROCKY_DB.prepare(
      `INSERT INTO entitlements
       (user_id, plan, status, source, current_period_end, created_at, updated_at,
        stripe_subscription_id, stripe_customer_id, stripe_price_id, last_event_at)
       VALUES (?, 'plus', ?, 'stripe', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = excluded.plan,
         status = excluded.status,
         source = excluded.source,
         current_period_end = excluded.current_period_end,
         updated_at = excluded.updated_at,
         stripe_subscription_id = excluded.stripe_subscription_id,
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_price_id = excluded.stripe_price_id,
         last_event_at = excluded.last_event_at
       WHERE entitlements.last_event_at IS NULL
          OR excluded.last_event_at >= entitlements.last_event_at`
    ).bind(
      userId,
      status,
      currentPeriodEnd,
      receivedAt,
      receivedAt,
      subscriptionId,
      customerId,
      priceId,
      occurredAt
    ),
    env.ROCKY_DB.prepare(
      `UPDATE entitlement_events
       SET user_id = ?, processed_at = ?
       WHERE event_id = ?`
    ).bind(userId, receivedAt, eventId)
  ]);

  return { duplicate: false, updated: true, userId, status };
}

export async function handleStripeWebhook(request, env, now = new Date()) {
  if (request.method !== "POST") {
    return {
      status: 405,
      body: { error: "method_not_allowed" },
      headers: { Allow: "POST" }
    };
  }
  if (!paymentsConfiguration(env).ready) {
    return { status: 503, body: { error: "payments_not_configured" } };
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  const rawBody = await request.text();
  if (textEncoder.encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  const valid = await verifyStripeSignature(
    rawBody,
    request.headers.get("Stripe-Signature"),
    env.STRIPE_WEBHOOK_SECRET,
    now
  );
  if (!valid) return { status: 401, body: { error: "invalid_signature" } };

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  try {
    const result = await processStripeEvent(env, event, now);
    return { status: 200, body: { ok: true, ...result } };
  } catch {
    return { status: 500, body: { error: "webhook_processing_failed" } };
  }
}
