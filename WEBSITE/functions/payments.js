import {
  authenticateRequestIdentity,
  getIdentityAccess
} from "./identity.js";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const PADDLE_IP_CACHE_MS = 60 * 60 * 1000;
const LIVE_CHECKOUT_HOSTNAME = "www.rockyaloha.com";
const PADDLE_SUBSCRIPTION_EVENTS = new Set([
  "subscription.activated",
  "subscription.canceled",
  "subscription.created",
  "subscription.past_due",
  "subscription.paused",
  "subscription.resumed",
  "subscription.trialing",
  "subscription.updated"
]);

const textEncoder = new TextEncoder();
let paddleIpCache = { baseUrl: "", cidrs: [], expiresAt: 0 };

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

function parsedPaddleSignature(header) {
  const values = {};
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    if (!values[name]) values[name] = [];
    values[name].push(value);
  }
  return {
    timestamp: Number(values.ts?.[0]),
    signatures: values.h1 || []
  };
}

export function paymentsConfiguration(env) {
  const enabled = env.ROCKY_PAYMENTS_ENABLED === "true";
  const environment = env.PADDLE_ENVIRONMENT === "sandbox"
    ? "sandbox"
    : "production";
  const sourceAllowlistReady = environment === "sandbox" || Boolean(env.PADDLE_API_KEY);
  const ready = Boolean(
    enabled &&
    sourceAllowlistReady &&
    env.PADDLE_CLIENT_TOKEN &&
    env.PADDLE_MONTHLY_PRICE_ID &&
    env.PADDLE_ANNUAL_PRICE_ID &&
    env.PADDLE_WEBHOOK_SECRET &&
    env.ROCKY_CHECKOUT_SECRET &&
    env.ROCKY_DB
  );

  return {
    enabled,
    ready,
    environment,
    clientToken: ready ? env.PADDLE_CLIENT_TOKEN : "",
    monthlyPriceId: ready ? env.PADDLE_MONTHLY_PRICE_ID : "",
    annualPriceId: ready ? env.PADDLE_ANNUAL_PRICE_ID : ""
  };
}

export function publicPaymentsConfiguration(env, hostname) {
  const config = paymentsConfiguration(env);
  if (
    config.environment !== "production" ||
    hostname === LIVE_CHECKOUT_HOSTNAME
  ) {
    return config;
  }

  return {
    ...config,
    ready: false,
    clientToken: "",
    monthlyPriceId: "",
    annualPriceId: ""
  };
}

function validPaddleIpv4Cidr(value) {
  const match = String(value || "").match(
    /^(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)\/32$/
  );
  return match ? match[0] : "";
}

async function currentPaddleIpv4Cidrs(env, fetcher = fetch, now = new Date()) {
  const baseUrl = env.PADDLE_ENVIRONMENT === "sandbox"
    ? "https://sandbox-api.paddle.com"
    : "https://api.paddle.com";
  const nowMs = now.getTime();

  if (
    paddleIpCache.baseUrl === baseUrl &&
    paddleIpCache.expiresAt > nowMs &&
    paddleIpCache.cidrs.length
  ) {
    return paddleIpCache.cidrs;
  }

  const response = await fetcher(`${baseUrl}/ips`, {
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${env.PADDLE_API_KEY}`
    }
  });
  if (!response.ok) throw new Error("Paddle IP allowlist is unavailable");

  const payload = await response.json();
  const cidrs = Array.isArray(payload?.data?.ipv4_cidrs)
    ? payload.data.ipv4_cidrs.map(validPaddleIpv4Cidr).filter(Boolean)
    : [];
  if (!cidrs.length) throw new Error("Paddle IP allowlist is empty");

  paddleIpCache = {
    baseUrl,
    cidrs,
    expiresAt: nowMs + PADDLE_IP_CACHE_MS
  };
  return cidrs;
}

async function paddleWebhookSourceAllowed(request, env, fetcher, now) {
  if (env.PADDLE_ENVIRONMENT === "sandbox") return true;

  const sourceIp = String(request.headers.get("CF-Connecting-IP") || "");
  const sourceCidr = validPaddleIpv4Cidr(`${sourceIp}/32`);
  if (!sourceCidr) return false;

  try {
    const cidrs = await currentPaddleIpv4Cidrs(env, fetcher, now);
    return cidrs.includes(sourceCidr);
  } catch {
    return false;
  }
}

export async function verifyPaddleSignature(
  rawBody,
  signatureHeader,
  secret,
  now = new Date()
) {
  if (!rawBody || !signatureHeader || !secret) return false;

  const { timestamp, signatures } = parsedPaddleSignature(signatureHeader);
  if (!Number.isInteger(timestamp) || signatures.length === 0) return false;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const expected = await hmacHex(secret, `${timestamp}:${rawBody}`);
  return signatures.some(signature => safeEqual(signature, expected));
}

export async function createCheckoutContext(userId, secret) {
  if (!userId || !secret) throw new Error("Checkout context is not configured");
  return {
    clerk_user_id: userId,
    rocky_checkout_signature: await hmacHex(secret, `rocky-checkout:${userId}`)
  };
}

export async function verifyCheckoutContext(customData, secret) {
  const userId = customData?.clerk_user_id;
  const signature = customData?.rocky_checkout_signature;
  if (!/^user_[A-Za-z0-9]+$/.test(String(userId || "")) || !signature) {
    return "";
  }

  const expected = await hmacHex(secret, `rocky-checkout:${userId}`);
  return safeEqual(signature, expected) ? userId : "";
}

export async function checkoutContext(
  request,
  env,
  resolveIdentity = authenticateRequestIdentity,
  resolveAccess = getIdentityAccess
) {
  const config = paymentsConfiguration(env);
  if (!config.enabled || !config.ready) {
    return { status: 503, body: { error: "payments_not_configured" } };
  }
  if (
    config.environment === "production" &&
    new URL(request.url).hostname !== LIVE_CHECKOUT_HOSTNAME
  ) {
    return { status: 403, body: { error: "checkout_host_not_allowed" } };
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

  return {
    status: 200,
    body: await createCheckoutContext(identity.userId, env.ROCKY_CHECKOUT_SECRET)
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
     WHERE paddle_subscription_id = ?`
  ).bind(subscriptionId).first();
  return String(row?.user_id || "");
}

export async function processPaddleEvent(env, event, now = new Date()) {
  if (!env.ROCKY_DB) throw new Error("ROCKY_DB is not configured");

  const eventId = String(event?.event_id || "");
  const eventType = String(event?.event_type || "");
  const occurredAt = String(event?.occurred_at || "");
  if (!/^evt_[A-Za-z0-9]+$/.test(eventId) || !eventType || !occurredAt) {
    throw new Error("Invalid Paddle event");
  }

  const receivedAt = now.toISOString();
  await env.ROCKY_DB.prepare(
    `INSERT OR IGNORE INTO entitlement_events
     (event_id, provider, event_type, user_id, received_at, processed_at)
     VALUES (?, 'paddle', ?, NULL, ?, NULL)`
  ).bind(eventId, eventType, receivedAt).run();

  const existing = await env.ROCKY_DB.prepare(
    `SELECT processed_at FROM entitlement_events WHERE event_id = ?`
  ).bind(eventId).first();
  if (existing?.processed_at) return { duplicate: true, updated: false };

  if (!PADDLE_SUBSCRIPTION_EVENTS.has(eventType)) {
    await markEventProcessed(env.ROCKY_DB, eventId, "", receivedAt);
    return { duplicate: false, updated: false };
  }

  const subscriptionId = String(event.data?.id || "");
  let userId = await userIdForSubscription(env.ROCKY_DB, subscriptionId);
  if (!userId) {
    userId = await verifyCheckoutContext(
      event.data?.custom_data,
      env.ROCKY_CHECKOUT_SECRET
    );
  }
  if (!userId) {
    await markEventProcessed(env.ROCKY_DB, eventId, "", receivedAt);
    return { duplicate: false, updated: false };
  }

  const acceptedPrices = new Set([
    env.PADDLE_MONTHLY_PRICE_ID,
    env.PADDLE_ANNUAL_PRICE_ID
  ].filter(Boolean));
  const priceId = event.data?.items
    ?.map(item => item?.price?.id)
    .find(candidate => acceptedPrices.has(candidate));

  if (!priceId) {
    await markEventProcessed(env.ROCKY_DB, eventId, userId, receivedAt);
    return { duplicate: false, updated: false };
  }

  const status = mappedEntitlementStatus(event.data?.status);
  const currentPeriodEnd = event.data?.current_billing_period?.ends_at || null;
  const customerId = String(event.data?.customer_id || "");

  await env.ROCKY_DB.batch([
    env.ROCKY_DB.prepare(
      `INSERT OR IGNORE INTO users (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?)`
    ).bind(userId, receivedAt, receivedAt),
    env.ROCKY_DB.prepare(
      `INSERT INTO entitlements
       (user_id, plan, status, source, current_period_end, created_at, updated_at,
        paddle_subscription_id, paddle_customer_id, paddle_price_id, last_event_at)
       VALUES (?, 'plus', ?, 'paddle', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = excluded.plan,
         status = excluded.status,
         source = excluded.source,
         current_period_end = excluded.current_period_end,
         updated_at = excluded.updated_at,
         paddle_subscription_id = excluded.paddle_subscription_id,
         paddle_customer_id = excluded.paddle_customer_id,
         paddle_price_id = excluded.paddle_price_id,
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

export async function handlePaddleWebhook(
  request,
  env,
  now = new Date(),
  fetcher = fetch
) {
  if (request.method !== "POST") {
    return { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "POST" } };
  }
  if (!paymentsConfiguration(env).ready) {
    return { status: 503, body: { error: "payments_not_configured" } };
  }
  if (!await paddleWebhookSourceAllowed(request, env, fetcher, now)) {
    return { status: 403, body: { error: "webhook_source_not_allowed" } };
  }

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  const rawBody = await request.text();
  if (textEncoder.encode(rawBody).byteLength > MAX_WEBHOOK_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }

  const valid = await verifyPaddleSignature(
    rawBody,
    request.headers.get("Paddle-Signature"),
    env.PADDLE_WEBHOOK_SECRET,
    now
  );
  if (!valid) return { status: 401, body: { error: "invalid_signature" } };

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }

  const result = await processPaddleEvent(env, event, now);
  return { status: 200, body: { ok: true, ...result } };
}
