const MAX_APPLICATION_BYTES = 8 * 1024;
const MAX_EVENT_BYTES = 2 * 1024;
const MAX_TURNSTILE_TOKEN_CHARS = 2048;

const CREATOR_PLATFORMS = new Set([
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "x",
  "linkedin",
  "podcast",
  "blog",
  "other"
]);

const AUDIENCE_RANGES = new Set([
  "under-1k",
  "1k-10k",
  "10k-50k",
  "50k-250k",
  "250k-plus"
]);

const CREATOR_EVENTS = new Set([
  "landing_view",
  "application_started",
  "application_submitted",
  "share_link_created",
  "share_clicked",
  "checkout_started"
]);

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

function response(body, status = 200, extraHeaders = {}) {
  return {
    status,
    body,
    headers: {
      ...RESPONSE_HEADERS,
      ...extraHeaders
    }
  };
}

function cleanText(value, maximum) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function validEmail(value) {
  const email = cleanText(value, 254).toLowerCase();
  if (!email || email.includes("..")) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "";
  return email;
}

function validProfileUrl(value) {
  const candidate = cleanText(value, 400);
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return "";
    if (url.username || url.password || !url.hostname.includes(".")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function campaignToken(value, maximum = 64) {
  const token = cleanText(value, maximum).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]*$/.test(token) ? token : "";
}

export function validReferralCode(value) {
  const code = campaignToken(value, 48);
  return code.length >= 3 ? code : "";
}

function creatorCode(name, randomUUID) {
  const base = cleanText(name, 80)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 18) || "creator";
  const suffix = String(randomUUID())
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 6);
  return `rocky-${base}-${suffix}`;
}

function safeSiteUrl(request, env) {
  const configured = cleanText(env.ROCKY_SITE_URL, 300);
  const url = new URL(configured || new URL(request.url).origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Creator links require HTTPS");
  }
  return url;
}

export function creatorShareUrl(request, env, referralCode) {
  const url = new URL("/", safeSiteUrl(request, env));
  url.searchParams.set("ref", referralCode);
  url.searchParams.set("utm_source", "creator");
  url.searchParams.set("utm_medium", "referral");
  url.searchParams.set("utm_campaign", "founding20");
  return url.toString();
}

async function hashIdentifier(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function enforceBurstLimits(env, request, scope) {
  if (!env.IP_RATE_LIMITER || !env.GLOBAL_RATE_LIMITER) {
    return response({ error: "creator_protection_unavailable" }, 503);
  }

  const remoteIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = await hashIdentifier(remoteIp);
  const [ipDecision, globalDecision] = await Promise.all([
    env.IP_RATE_LIMITER.limit({ key: `${scope}:${ipKey}` }),
    env.GLOBAL_RATE_LIMITER.limit({ key: `${scope}:global` })
  ]);

  if (!ipDecision.success || !globalDecision.success) {
    return response(
      { error: "creator_rate_limited" },
      429,
      { "Retry-After": "60" }
    );
  }
  return null;
}

async function verifyTurnstile(token, request, env, fetcher) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    return response({ error: "creator_protection_unavailable" }, 503);
  }
  if (
    typeof token !== "string" ||
    !token ||
    token.length > MAX_TURNSTILE_TOKEN_CHARS
  ) {
    return response({ error: "creator_verification_required" }, 403);
  }

  let verificationResponse;
  try {
    verificationResponse = await fetcher(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: request.headers.get("CF-Connecting-IP") || "unknown",
          idempotency_key: crypto.randomUUID()
        })
      }
    );
  } catch {
    return response({ error: "creator_verification_unavailable" }, 503);
  }

  if (!verificationResponse.ok) {
    return response({ error: "creator_verification_unavailable" }, 503);
  }

  const verification = await verificationResponse.json();
  if (
    !verification.success ||
    verification.action !== "creator_apply" ||
    verification.hostname !== new URL(request.url).hostname
  ) {
    return response({ error: "creator_verification_failed" }, 403);
  }
  return null;
}

function creatorApplication(payload) {
  const name = cleanText(payload?.name, 80);
  const email = validEmail(payload?.email);
  const platform = cleanText(payload?.platform, 24).toLowerCase();
  const profileUrl = validProfileUrl(payload?.profileUrl);
  const audienceRange = cleanText(payload?.audienceRange, 24).toLowerCase();
  const message = cleanText(payload?.message, 1200);
  const source = campaignToken(payload?.source) || "direct";
  const campaign = campaignToken(payload?.campaign) || "founding20";

  if (
    name.length < 2 ||
    !email ||
    !CREATOR_PLATFORMS.has(platform) ||
    !profileUrl ||
    !AUDIENCE_RANGES.has(audienceRange) ||
    message.length < 20 ||
    payload?.consent !== true
  ) {
    return null;
  }

  return {
    name,
    email,
    platform,
    profileUrl,
    audienceRange,
    message,
    source,
    campaign
  };
}

export function creatorsConfiguration(env) {
  const enabled = env.ROCKY_CREATORS_ENABLED === "true";
  return {
    enabled,
    ready: Boolean(
      enabled &&
      env.ROCKY_DB &&
      env.TURNSTILE_SITE_KEY &&
      env.TURNSTILE_SECRET_KEY
    ),
    program: "founding20"
  };
}

export async function handleCreatorApplication(
  request,
  env,
  {
    fetcher = fetch,
    now = new Date(),
    randomUUID = crypto.randomUUID.bind(crypto)
  } = {}
) {
  if (request.method !== "POST") {
    return response(
      { error: "method_not_allowed" },
      405,
      { Allow: "POST" }
    );
  }

  const configuration = creatorsConfiguration(env);
  if (!configuration.enabled || !configuration.ready) {
    return response({ error: "creator_program_not_ready" }, 503);
  }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return response({ error: "json_required" }, 415);
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_APPLICATION_BYTES) {
    return response({ error: "request_too_large" }, 413);
  }

  let payload;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_APPLICATION_BYTES) {
      return response({ error: "request_too_large" }, 413);
    }
    payload = JSON.parse(rawBody);
  } catch {
    return response({ error: "invalid_json" }, 400);
  }

  if (cleanText(payload?.website, 200)) {
    return response({ ok: true }, 202);
  }

  const application = creatorApplication(payload);
  if (!application) {
    return response({ error: "invalid_creator_application" }, 400);
  }

  const burstLimit = await enforceBurstLimits(
    env,
    request,
    "creator-apply"
  );
  if (burstLimit) return burstLimit;

  const turnstileFailure = await verifyTurnstile(
    payload.turnstileToken,
    request,
    env,
    fetcher
  );
  if (turnstileFailure) return turnstileFailure;

  const createdAt = now.toISOString();
  const applicationId = `creator_${String(randomUUID()).replace(/-/g, "")}`;
  const referralCode = creatorCode(application.name, randomUUID);

  let stored;
  try {
    stored = await env.ROCKY_DB.prepare(
      `INSERT INTO creator_applications
       (application_id, status, name, email, platform, profile_url,
        audience_range, message, referral_code, source, campaign,
        consent_at, created_at, updated_at)
       VALUES (?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         name = excluded.name,
         platform = excluded.platform,
         profile_url = excluded.profile_url,
         audience_range = excluded.audience_range,
         message = excluded.message,
         source = excluded.source,
         campaign = excluded.campaign,
         consent_at = excluded.consent_at,
         updated_at = excluded.updated_at
       RETURNING application_id, referral_code`
    ).bind(
      applicationId,
      application.name,
      application.email,
      application.platform,
      application.profileUrl,
      application.audienceRange,
      application.message,
      referralCode,
      application.source,
      application.campaign,
      createdAt,
      createdAt,
      createdAt
    ).first();
  } catch (error) {
    console.error("Creator application storage failed", {
      reason: String(error?.message || "unknown").slice(0, 120)
    });
    return response({ error: "creator_application_unavailable" }, 503);
  }

  if (!stored?.application_id || !validReferralCode(stored.referral_code)) {
    return response({ error: "creator_application_unavailable" }, 503);
  }

  const shareUrl = creatorShareUrl(
    request,
    env,
    stored.referral_code
  );

  return response({
    ok: true,
    applicationId: stored.application_id,
    referralCode: stored.referral_code,
    shareUrl
  }, 201);
}

export async function handleCreatorEvent(
  request,
  env,
  { now = new Date() } = {}
) {
  if (request.method !== "POST") {
    return response(
      { error: "method_not_allowed" },
      405,
      { Allow: "POST" }
    );
  }

  const configuration = creatorsConfiguration(env);
  if (!configuration.enabled || !configuration.ready) {
    return response({ error: "creator_program_not_ready" }, 503);
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_EVENT_BYTES) {
    return response({ error: "request_too_large" }, 413);
  }

  let payload;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_EVENT_BYTES) {
      return response({ error: "request_too_large" }, 413);
    }
    payload = JSON.parse(rawBody);
  } catch {
    return response({ error: "invalid_json" }, 400);
  }

  const eventName = cleanText(payload?.event, 40).toLowerCase();
  if (!CREATOR_EVENTS.has(eventName)) {
    return response({ error: "invalid_creator_event" }, 400);
  }

  const burstLimit = await enforceBurstLimits(
    env,
    request,
    "creator-event"
  );
  if (burstLimit) return burstLimit;

  const eventDate = now.toISOString().slice(0, 10);
  const updatedAt = now.toISOString();
  const referralCode = validReferralCode(payload?.referralCode);
  const source = campaignToken(payload?.source) || "direct";
  const campaign = campaignToken(payload?.campaign) || "founding20";

  try {
    await env.ROCKY_DB.prepare(
      `INSERT INTO creator_daily_events
       (event_date, event_name, referral_code, source, campaign,
        event_count, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(event_date, event_name, referral_code, source, campaign)
       DO UPDATE SET
         event_count = creator_daily_events.event_count + 1,
         updated_at = excluded.updated_at`
    ).bind(
      eventDate,
      eventName,
      referralCode,
      source,
      campaign,
      updatedAt
    ).run();
  } catch (error) {
    console.error("Creator event storage failed", {
      event: eventName,
      reason: String(error?.message || "unknown").slice(0, 120)
    });
    return response({ error: "creator_event_unavailable" }, 503);
  }

  return response({ ok: true }, 202);
}

export async function recordCreatorReferral(
  env,
  {
    subscriptionId,
    userId,
    referralCode,
    status,
    eventId,
    occurredAt,
    receivedAt
  }
) {
  if (
    env.ROCKY_CREATORS_ENABLED !== "true" ||
    !env.ROCKY_DB ||
    !subscriptionId
  ) {
    return false;
  }

  const code = validReferralCode(referralCode);
  try {
    if (code) {
      const creator = await env.ROCKY_DB.prepare(
        `SELECT referral_code
         FROM creator_applications
         WHERE referral_code = ? AND status != 'declined'`
      ).bind(code).first();
      if (!creator?.referral_code) return false;

      await env.ROCKY_DB.prepare(
        `INSERT INTO creator_referrals
         (stripe_subscription_id, user_id, referral_code, status,
          stripe_event_id, occurred_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(stripe_subscription_id) DO UPDATE SET
           user_id = excluded.user_id,
           referral_code = excluded.referral_code,
           status = excluded.status,
           stripe_event_id = excluded.stripe_event_id,
           occurred_at = excluded.occurred_at,
           updated_at = excluded.updated_at
         WHERE creator_referrals.occurred_at IS NULL
            OR excluded.occurred_at >= creator_referrals.occurred_at`
      ).bind(
        subscriptionId,
        userId,
        code,
        status,
        eventId,
        occurredAt,
        receivedAt,
        receivedAt
      ).run();
      return true;
    }

    await env.ROCKY_DB.prepare(
      `UPDATE creator_referrals
       SET status = ?, stripe_event_id = ?, occurred_at = ?, updated_at = ?
       WHERE stripe_subscription_id = ?
         AND (occurred_at IS NULL OR ? >= occurred_at)`
    ).bind(
      status,
      eventId,
      occurredAt,
      receivedAt,
      subscriptionId,
      occurredAt
    ).run();
    return true;
  } catch (error) {
    console.error("Creator referral tracking failed", {
      reason: String(error?.message || "unknown").slice(0, 120)
    });
    return false;
  }
}
