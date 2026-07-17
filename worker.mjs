import { DurableObject } from "cloudflare:workers";
import { onRequestPost } from "./WEBSITE/functions/ask-rocky.js";
import {
  identityConfiguration,
  identityStatus
} from "./WEBSITE/functions/identity.js";
import {
  canonicalRedirectFor,
  healthState
} from "./WEBSITE/functions/site-routing.js";

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extraHeaders
    }
  });
}

export class RockyUsageLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        counter_key TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL
      ) STRICT
    `);
  }

  consume(ipKey, ipLimit, globalLimit) {
    const globalCount = this.#countFor("global");
    const ipCount = this.#countFor(`ip:${ipKey}`);

    if (globalCount >= globalLimit) {
      return { allowed: false, reason: "global_daily_limit" };
    }

    if (ipCount >= ipLimit) {
      return { allowed: false, reason: "ip_daily_limit" };
    }

    this.#increment("global");
    this.#increment(`ip:${ipKey}`);

    return {
      allowed: true,
      globalRemaining: Math.max(0, globalLimit - globalCount - 1),
      ipRemaining: Math.max(0, ipLimit - ipCount - 1)
    };
  }

  consumeGlobal(globalLimit) {
    const globalCount = this.#countFor("global");

    if (globalCount >= globalLimit) {
      return { allowed: false, reason: "global_daily_limit" };
    }

    this.#increment("global");
    return {
      allowed: true,
      globalRemaining: Math.max(0, globalLimit - globalCount - 1)
    };
  }

  #countFor(key) {
    const rows = this.sql
      .exec(
        "SELECT request_count FROM counters WHERE counter_key = ?",
        key
      )
      .toArray();

    return Number(rows[0]?.request_count || 0);
  }

  #increment(key) {
    this.sql.exec(
      `INSERT INTO counters (counter_key, request_count)
       VALUES (?, 1)
       ON CONFLICT(counter_key)
       DO UPDATE SET request_count = request_count + 1`,
      key
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const canonicalUrl = canonicalRedirectFor(url);

    if (canonicalUrl) {
      return new Response(null, {
        status: 308,
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Location": canonicalUrl,
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return jsonResponse(
          { error: "method_not_allowed" },
          405,
          { Allow: "GET" }
        );
      }

      const health = healthState(env);
      return jsonResponse(health.body, health.status);
    }

    if (url.pathname === "/rocky-config") {
      if (request.method !== "GET") {
        return jsonResponse(
          { error: "method_not_allowed" },
          405,
          { Allow: "GET" }
        );
      }

      return jsonResponse({
        turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
        protected: Boolean(
          env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
        ),
        identity: identityConfiguration(env)
      });
    }

    if (url.pathname === "/me") {
      if (request.method !== "GET") {
        return jsonResponse(
          { error: "method_not_allowed" },
          405,
          { Allow: "GET" }
        );
      }

      const result = await identityStatus(request, env);
      return jsonResponse(result.body, result.status);
    }

    if (url.pathname === "/ask-rocky") {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "method_not_allowed" },
          405,
          { Allow: "POST" }
        );
      }

      return onRequestPost({ request, env });
    }

    return env.ASSETS.fetch(request);
  }
};
