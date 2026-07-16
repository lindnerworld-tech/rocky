import {
  authenticateRequestIdentity,
  consumeIdentityAllowance
} from "./identity.js";

const MAX_BODY_BYTES = 4096;
const MAX_QUESTION_CHARS = 1000;
const MAX_TURNSTILE_TOKEN_CHARS = 2048;
const DEFAULT_DAILY_IP_LIMIT = 1;
const DEFAULT_GLOBAL_DAILY_LIMIT = 500;

const ALLOWED_CATEGORIES = new Set([
  "life",
  "money",
  "business",
  "relationships",
  "courage"
]);

const RESPONSE_HEADERS = {
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
      ...RESPONSE_HEADERS,
      ...extraHeaders
    }
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000));
}

async function hashIdentifier(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function enforceBurstLimits(env, ipKey) {
  if (!env.IP_RATE_LIMITER || !env.GLOBAL_RATE_LIMITER) {
    return {
      allowed: false,
      response: jsonResponse(
        { answer: "Rocky's protection is not ready yet. Try again shortly." },
        503
      )
    };
  }

  const [ipDecision, globalDecision] = await Promise.all([
    env.IP_RATE_LIMITER.limit({ key: `ask-rocky:${ipKey}` }),
    env.GLOBAL_RATE_LIMITER.limit({ key: "ask-rocky:global" })
  ]);

  if (!ipDecision.success || !globalDecision.success) {
    return {
      allowed: false,
      response: jsonResponse(
        { answer: "Too many waves at once. Give Rocky a minute." },
        429,
        { "Retry-After": "60" }
      )
    };
  }

  return { allowed: true };
}

async function validateTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) {
    return {
      valid: false,
      response: jsonResponse(
        { answer: "Rocky's safety check is not configured yet." },
        503
      )
    };
  }

  if (
    typeof token !== "string" ||
    !token ||
    token.length > MAX_TURNSTILE_TOKEN_CHARS
  ) {
    return {
      valid: false,
      response: jsonResponse(
        { answer: "Please complete Rocky's quick safety check." },
        403
      )
    };
  }

  const remoteIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const verificationResponse = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp,
        idempotency_key: crypto.randomUUID()
      })
    }
  );

  if (!verificationResponse.ok) {
    return {
      valid: false,
      response: jsonResponse(
        { answer: "Rocky's safety check is resting. Try again shortly." },
        503
      )
    };
  }

  const verification = await verificationResponse.json();
  const expectedHostname = new URL(request.url).hostname;

  if (
    !verification.success ||
    verification.action !== "ask_rocky" ||
    verification.hostname !== expectedHostname
  ) {
    return {
      valid: false,
      response: jsonResponse(
        { answer: "Rocky could not verify that request. Please try again." },
        403
      )
    };
  }

  return { valid: true };
}

async function consumeDailyAllowance(env, ipKey) {
  if (!env.USAGE_LIMITER) {
    return {
      allowed: false,
      response: jsonResponse(
        { answer: "Rocky's daily counter is not ready yet." },
        503
      )
    };
  }

  const ipLimit = boundedInteger(
    env.ROCKY_DAILY_IP_LIMIT,
    DEFAULT_DAILY_IP_LIMIT,
    1,
    100
  );
  const globalLimit = boundedInteger(
    env.ROCKY_GLOBAL_DAILY_LIMIT,
    DEFAULT_GLOBAL_DAILY_LIMIT,
    1,
    100000
  );
  const utcDay = new Date().toISOString().slice(0, 10);
  const limiter = env.USAGE_LIMITER.getByName(utcDay);
  const decision = await limiter.consume(ipKey, ipLimit, globalLimit);

  if (!decision.allowed) {
    const answer = decision.reason === "global_daily_limit"
      ? "Rocky has reached today's safety limit. The tide resets tomorrow."
      : "Rocky has shared enough perspective here for today. Come back tomorrow.";

    return {
      allowed: false,
      response: jsonResponse(
        { answer },
        429,
        { "Retry-After": String(secondsUntilUtcMidnight()) }
      )
    };
  }

  const remaining = Number.isFinite(decision.ipRemaining)
    ? decision.ipRemaining
    : Math.max(0, ipLimit - 1);

  return {
    allowed: true,
    access: {
      authenticated: false,
      plan: "guest",
      dailyLimit: ipLimit,
      used: Math.max(0, ipLimit - remaining),
      remaining
    }
  };
}

async function consumeGlobalAllowance(env) {
  if (!env.USAGE_LIMITER) {
    return {
      allowed: false,
      response: jsonResponse(
        { answer: "Rocky's daily counter is not ready yet." },
        503
      )
    };
  }

  const globalLimit = boundedInteger(
    env.ROCKY_GLOBAL_DAILY_LIMIT,
    DEFAULT_GLOBAL_DAILY_LIMIT,
    1,
    100000
  );
  const utcDay = new Date().toISOString().slice(0, 10);
  const limiter = env.USAGE_LIMITER.getByName(utcDay);
  const decision = await limiter.consumeGlobal(globalLimit);

  if (!decision.allowed) {
    return {
      allowed: false,
      response: jsonResponse(
        { answer: "Rocky has reached today's safety limit. The tide resets tomorrow." },
        429,
        { "Retry-After": String(secondsUntilUtcMidnight()) }
      )
    };
  }

  return { allowed: true };
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    if (env.ROCKY_AI_ENABLED === "false") {
      return jsonResponse(
        { answer: "Rocky is resting right now. Please come back later." },
        503
      );
    }

    if (!env.OPENAI_API_KEY) {
      return jsonResponse(
        { answer: "Rocky's voice is not configured yet." },
        503
      );
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return jsonResponse(
        { answer: "Rocky only accepts a small written question." },
        415
      );
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse(
        { answer: "That question is carrying too many stones. Make it shorter." },
        413
      );
    }

    const remoteIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipKey = await hashIdentifier(remoteIp);
    const burstLimit = await enforceBurstLimits(env, ipKey);
    if (!burstLimit.allowed) return burstLimit.response;

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonResponse(
        { answer: "That question is carrying too many stones. Make it shorter." },
        413
      );
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        { answer: "Rocky could not read that question. Please try again." },
        400
      );
    }

    const question = String(body.question || "")
      .trim()
      .slice(0, MAX_QUESTION_CHARS);
    const category = ALLOWED_CATEGORIES.has(body.category)
      ? body.category
      : "life";

    if (!question) {
      return jsonResponse({
        answer: "Ask me something, friend. Even rocks listen better with a question."
      }, 400);
    }

    const turnstile = await validateTurnstile(
      body.turnstileToken,
      request,
      env
    );
    if (!turnstile.valid) return turnstile.response;

    const resolveIdentity = context.resolveIdentity || authenticateRequestIdentity;
    const useIdentityAllowance = context.consumeIdentityAllowance ||
      consumeIdentityAllowance;
    const identity = await resolveIdentity(request, env);

    if (identity.error === "identity_not_configured") {
      return jsonResponse(
        { answer: "Rocky's sign-in is not ready yet. Try again shortly." },
        503
      );
    }

    if (identity.error === "invalid_session") {
      return jsonResponse(
        { answer: "Your Rocky sign-in needs refreshing. Please sign in again." },
        401
      );
    }

    let dailyAllowance;
    if (identity.authenticated) {
      const globalAllowance = await consumeGlobalAllowance(env);
      if (!globalAllowance.allowed) return globalAllowance.response;

      try {
        const decision = await useIdentityAllowance(env, identity.userId);
        if (!decision.allowed) {
          return jsonResponse(
            {
              answer: "Rocky has shared today's Free perspective. Come back tomorrow or choose Plus for more.",
              access: decision.access
            },
            429,
            { "Retry-After": String(secondsUntilUtcMidnight()) }
          );
        }
        dailyAllowance = decision;
      } catch {
        return jsonResponse(
          { answer: "Rocky's account counter is not ready yet. Try again shortly." },
          503
        );
      }
    } else {
      dailyAllowance = await consumeDailyAllowance(env, ipKey);
    }

    if (!dailyAllowance.allowed) return dailyAllowance.response;

    const rockyPrompt = `
You are Rocky, a 4-billion-year-old Hawaiian rock.

Your mission is to become the world's most loved daily source of perspective.

Your promise:
Rocky helps people gain perspective in less than 60 seconds.

Your vision:
When life gets noisy, people go to Rocky.

You are not:
- A coach
- A guru
- A celebrity
- A motivational speaker
- A therapist

You offer perspective, not lectures.

Rocky's five principles:
1. Time Reveals
2. Nature Teaches
3. Perspective Changes Everything
4. Character Matters
5. One Step Is Enough

Rocky always:
- Stays calm
- Stays brief
- Uses simple words
- Uses island humor when natural
- Gives perspective
- Leaves people feeling lighter

Rocky never:
- Argues
- Shames
- Panics
- Lectures
- Overwhelms
- Creates fear
- Creates division

Use imagery from:
Ocean, tides, lava, mountains, stones, rain, trade winds, forests, surf, patience, aloha, and time.

Style:
Short.
Wise.
Warm.
Memorable.
Slightly funny when appropriate.

Answer in 1 to 4 sentences.

Category: ${category}

Question:
${question}
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: rockyPrompt,
        max_output_tokens: 160,
        store: false
      })
    });

    if (!response.ok) {
      console.error("OpenAI API error status:", response.status);
      return jsonResponse(
        { answer: "The tide is quiet right now. Ask Rocky again in a moment." },
        502
      );
    }

    const data = await response.json();
    const answer = (data.output || [])
      .flatMap(item => item.content || [])
      .find(content => content.type === "output_text")
      ?.text;

    return jsonResponse({
      answer: answer || "The tide is quiet right now. Ask me again in a moment.",
      access: dailyAllowance.access
    });
  } catch (error) {
    console.error("Ask Rocky error:", error);

    return jsonResponse(
      { answer: "Even rocks hit rough ground sometimes. Try again in a moment." },
      500
    );
  }
}
