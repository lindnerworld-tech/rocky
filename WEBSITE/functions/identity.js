import { verifyToken } from "@clerk/backend";

export const FREE_DAILY_LIMIT = 1;
export const PLUS_DAILY_LIMIT = 20;

const ACTIVE_PLUS_STATUSES = new Set(["active", "trialing"]);

export function identityConfiguration(env) {
  const enabled = env.ROCKY_IDENTITY_ENABLED === "true";
  const ready = Boolean(
    enabled &&
    env.CLERK_PUBLISHABLE_KEY &&
    env.CLERK_JWT_KEY &&
    env.ROCKY_DB
  );

  return {
    enabled,
    ready,
    publishableKey: ready ? env.CLERK_PUBLISHABLE_KEY : ""
  };
}

export function bearerTokenFrom(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] || "";
}

export async function authenticateRequestIdentity(request, env) {
  if (env.ROCKY_IDENTITY_ENABLED !== "true") {
    return { enabled: false, authenticated: false };
  }

  if (!env.CLERK_JWT_KEY || !env.CLERK_PUBLISHABLE_KEY || !env.ROCKY_DB) {
    return {
      enabled: true,
      authenticated: false,
      error: "identity_not_configured"
    };
  }

  const token = bearerTokenFrom(request);
  if (!token) return { enabled: true, authenticated: false };

  try {
    const claims = await verifyToken(token, {
      jwtKey: env.CLERK_JWT_KEY,
      authorizedParties: [new URL(request.url).origin]
    });

    if (!claims.sub || claims.sts === "pending") {
      throw new Error("Incomplete Clerk session");
    }

    return {
      enabled: true,
      authenticated: true,
      userId: claims.sub
    };
  } catch {
    return {
      enabled: true,
      authenticated: false,
      error: "invalid_session"
    };
  }
}

export function accessPlanFor(entitlement, now = new Date()) {
  if (!entitlement || entitlement.plan !== "plus") {
    return { plan: "free", dailyLimit: FREE_DAILY_LIMIT };
  }

  const hasPeriodEnd = Boolean(entitlement.current_period_end);
  const hasNotEnded = !hasPeriodEnd ||
    new Date(entitlement.current_period_end).getTime() > now.getTime();
  const isActive = ACTIVE_PLUS_STATUSES.has(entitlement.status) ||
    (entitlement.status === "canceled" && hasPeriodEnd && hasNotEnded);

  if (!isActive || !hasNotEnded) {
    return { plan: "free", dailyLimit: FREE_DAILY_LIMIT };
  }

  return { plan: "plus", dailyLimit: PLUS_DAILY_LIMIT };
}

async function ensureAccount(db, userId, nowIso) {
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO users (id, status, created_at, updated_at)
       VALUES (?, 'active', ?, ?)`
    ).bind(userId, nowIso, nowIso),
    db.prepare(
      `INSERT OR IGNORE INTO entitlements
       (user_id, plan, status, source, current_period_end, created_at, updated_at)
       VALUES (?, 'free', 'active', 'signup', NULL, ?, ?)`
    ).bind(userId, nowIso, nowIso)
  ]);
}

async function entitlementFor(db, userId) {
  return db.prepare(
    `SELECT plan, status, source, current_period_end, paddle_customer_id
     FROM entitlements
     WHERE user_id = ?`
  ).bind(userId).first();
}

function paddleCustomerIdFor(entitlement) {
  const customerId = String(entitlement?.paddle_customer_id || "");
  return /^ctm_[A-Za-z0-9]+$/.test(customerId) ? customerId : "";
}

async function usedToday(db, userId, utcDay) {
  const row = await db.prepare(
    `SELECT answer_count
     FROM usage_daily
     WHERE user_id = ? AND usage_date = ?`
  ).bind(userId, utcDay).first();

  return Number(row?.answer_count || 0);
}

export async function getIdentityAccess(env, userId, now = new Date()) {
  if (!env.ROCKY_DB) throw new Error("ROCKY_DB is not configured");

  const nowIso = now.toISOString();
  const utcDay = nowIso.slice(0, 10);
  await ensureAccount(env.ROCKY_DB, userId, nowIso);

  const entitlement = await entitlementFor(env.ROCKY_DB, userId);
  const access = accessPlanFor(entitlement, now);
  const used = await usedToday(env.ROCKY_DB, userId, utcDay);

  return {
    authenticated: true,
    ...access,
    paddleCustomerId: paddleCustomerIdFor(entitlement),
    used,
    remaining: Math.max(0, access.dailyLimit - used)
  };
}

export async function consumeIdentityAllowance(env, userId, now = new Date()) {
  if (!env.ROCKY_DB) throw new Error("ROCKY_DB is not configured");

  const nowIso = now.toISOString();
  const utcDay = nowIso.slice(0, 10);
  await ensureAccount(env.ROCKY_DB, userId, nowIso);

  const entitlement = await entitlementFor(env.ROCKY_DB, userId);
  const access = accessPlanFor(entitlement, now);
  const row = await env.ROCKY_DB.prepare(
    `INSERT INTO usage_daily (user_id, usage_date, answer_count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id, usage_date) DO UPDATE SET
       answer_count = usage_daily.answer_count + 1,
       updated_at = excluded.updated_at
     WHERE usage_daily.answer_count < ?
     RETURNING answer_count`
  ).bind(userId, utcDay, nowIso, access.dailyLimit).first();

  if (!row) {
    return {
      allowed: false,
      reason: "account_daily_limit",
      access: {
        authenticated: true,
        ...access,
        used: access.dailyLimit,
        remaining: 0
      }
    };
  }

  const used = Number(row.answer_count || 0);
  return {
    allowed: true,
    access: {
      authenticated: true,
      ...access,
      used,
      remaining: Math.max(0, access.dailyLimit - used)
    }
  };
}

export async function refundIdentityAllowance(env, userId, now = new Date()) {
  if (!env.ROCKY_DB) throw new Error("ROCKY_DB is not configured");

  const nowIso = now.toISOString();
  const utcDay = nowIso.slice(0, 10);
  await env.ROCKY_DB.prepare(
    `UPDATE usage_daily
     SET answer_count = answer_count - 1,
         updated_at = ?
     WHERE user_id = ? AND usage_date = ? AND answer_count > 0
     RETURNING answer_count`
  ).bind(nowIso, userId, utcDay).first();

  return getIdentityAccess(env, userId, now);
}

export async function identityStatus(request, env, resolveIdentity = authenticateRequestIdentity) {
  const identity = await resolveIdentity(request, env);

  if (identity.error === "identity_not_configured") {
    return {
      status: 503,
      body: { error: "identity_not_configured" }
    };
  }

  if (identity.error === "invalid_session") {
    return {
      status: 401,
      body: { error: "invalid_session" }
    };
  }

  if (!identity.authenticated) {
    return {
      status: 200,
      body: {
        enabled: identity.enabled,
        authenticated: false,
        plan: "guest",
        dailyLimit: FREE_DAILY_LIMIT,
        used: 0,
        remaining: FREE_DAILY_LIMIT
      }
    };
  }

  try {
    const access = await getIdentityAccess(env, identity.userId);
    return {
      status: 200,
      body: { enabled: true, ...access }
    };
  } catch {
    return {
      status: 503,
      body: { error: "identity_store_unavailable" }
    };
  }
}
