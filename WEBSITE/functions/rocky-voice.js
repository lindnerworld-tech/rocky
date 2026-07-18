const MAX_BODY_BYTES = 4096;
const MAX_ANSWER_CHARS = 1200;
const MAX_TICKET_CHARS = 256;
const SPEECH_TICKET_TTL_SECONDS = 5 * 60;
const SPEECH_TICKET_VERSION = "v1";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

const ROCKY_SPEECH_INSTRUCTIONS = `
Speak as Rocky, a four-billion-year-old pet rock shaped by Hawaii's land and ocean.
This is not a contemporary young or middle-aged speaker. Rocky must sound ancient and elemental—as if a mountain learned to speak.
As a minimum human reference, use the unmistakable vocal age of a healthy man in his late eighties or nineties. Never sound under seventy.
Use the lowest comfortable baritone register with deep chest resonance and a subtle weathered, stone-like grain.
Keep the voice strong and clear, never frail. Remove youthful brightness, airy smoothness, and modern conversational energy.
Speak very slowly and deliberately. Give important words room, with generous natural silence between thoughts.
Use little melodic variation. End statements with a low, calm downward cadence and settled certainty.
Comfort the listener through steadiness, presence, and perspective—not sweetness or sentimentality.
Carry quiet authority without arrogance. Use only the faintest knowing half-smile when dry humor truly fits.
Avoid breathy energy, excitement, pep, theatrical drama, polished-host delivery, and forced friendliness.
Never sound frail, sleepy, ominous, salesy, or like a coach, announcer, guru, therapist, celebrity, or cartoon character.
Use clear standard English. Do not imitate Hawaiian, local, or pidgin speech.
Do not rush the final sentence. Leave a moment of silence around it and let it land like a stone settling into earth.
`.trim();

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

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid_base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

async function speechSigningKey(openAiApiKey) {
  if (!openAiApiKey) throw new Error("voice_key_unavailable");

  const encoder = new TextEncoder();
  const sourceKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(openAiApiKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("project-rocky-voice-v1"),
      info: encoder.encode("speech-ticket")
    },
    sourceKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}

function ticketPayload(expiresAt, nonce, audience, ipKey, answer) {
  return new TextEncoder().encode(
    [
      SPEECH_TICKET_VERSION,
      expiresAt,
      nonce,
      audience,
      ipKey,
      answer
    ].join("\n")
  );
}

export function voiceEnabledForEnvironment(env) {
  if (env.ROCKY_VOICE_ENABLED === "true") return true;
  if (env.ROCKY_VOICE_ENABLED === "false") return false;
  return env.PADDLE_ENVIRONMENT === "sandbox";
}

export function publicVoiceConfiguration(env) {
  const enabled = voiceEnabledForEnvironment(env);
  return {
    enabled,
    ready: enabled && Boolean(env.OPENAI_API_KEY),
    disclosure: "AI-generated voice"
  };
}

export async function createSpeechTicket(
  answer,
  ipKey,
  openAiApiKey,
  audience,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  if (
    typeof answer !== "string" ||
    !answer ||
    answer.length > MAX_ANSWER_CHARS ||
    typeof ipKey !== "string" ||
    !ipKey ||
    typeof audience !== "string" ||
    !audience
  ) {
    throw new Error("invalid_speech_ticket_input");
  }

  const expiresAt = nowSeconds + SPEECH_TICKET_TTL_SECONDS;
  const nonceBytes = crypto.getRandomValues(new Uint8Array(12));
  const nonce = toBase64Url(nonceBytes);
  const key = await speechSigningKey(openAiApiKey);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    ticketPayload(expiresAt, nonce, audience, ipKey, answer)
  );

  return [
    SPEECH_TICKET_VERSION,
    expiresAt,
    nonce,
    toBase64Url(new Uint8Array(signature))
  ].join(".");
}

export async function verifySpeechTicket(
  ticket,
  answer,
  ipKey,
  openAiApiKey,
  audience,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  if (
    typeof ticket !== "string" ||
    !ticket ||
    ticket.length > MAX_TICKET_CHARS ||
    typeof answer !== "string" ||
    !answer ||
    answer.length > MAX_ANSWER_CHARS ||
    typeof ipKey !== "string" ||
    !ipKey ||
    typeof audience !== "string" ||
    !audience
  ) {
    return false;
  }

  const parts = ticket.split(".");
  if (parts.length !== 4 || parts[0] !== SPEECH_TICKET_VERSION) return false;

  const expiresAt = Number(parts[1]);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < nowSeconds ||
    expiresAt > nowSeconds + SPEECH_TICKET_TTL_SECONDS
  ) {
    return false;
  }

  try {
    const key = await speechSigningKey(openAiApiKey);
    const signature = fromBase64Url(parts[3]);
    return crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      ticketPayload(expiresAt, parts[2], audience, ipKey, answer)
    );
  } catch {
    return false;
  }
}

async function hashIdentifier(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function enforceVoiceBurstLimits(env, ipKey) {
  if (!env.IP_RATE_LIMITER || !env.GLOBAL_RATE_LIMITER) {
    return {
      allowed: false,
      response: jsonResponse(
        { error: "voice_protection_unavailable" },
        503
      )
    };
  }

  const [ipDecision, globalDecision] = await Promise.all([
    env.IP_RATE_LIMITER.limit({ key: `speak-rocky:${ipKey}` }),
    env.GLOBAL_RATE_LIMITER.limit({ key: "speak-rocky:global" })
  ]);

  if (!ipDecision.success || !globalDecision.success) {
    return {
      allowed: false,
      response: jsonResponse(
        { error: "voice_rate_limited" },
        429,
        { "Retry-After": "60" }
      )
    };
  }

  return { allowed: true };
}

export async function onRequestSpeakRocky(context) {
  try {
    const { request, env } = context;

    if (!voiceEnabledForEnvironment(env)) {
      return jsonResponse({ error: "voice_disabled" }, 503);
    }

    if (!env.OPENAI_API_KEY) {
      return jsonResponse({ error: "voice_not_configured" }, 503);
    }

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return jsonResponse({ error: "json_required" }, 415);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }

    const remoteIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const ipKey = await hashIdentifier(remoteIp);
    const burstLimit = await enforceVoiceBurstLimits(env, ipKey);
    if (!burstLimit.allowed) return burstLimit.response;

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const answer = typeof body.answer === "string" ? body.answer : "";
    const speechTicket = typeof body.speechTicket === "string"
      ? body.speechTicket
      : "";

    if (
      !answer ||
      answer !== answer.trim() ||
      answer.length > MAX_ANSWER_CHARS
    ) {
      return jsonResponse({ error: "invalid_answer" }, 400);
    }

    const validTicket = await verifySpeechTicket(
      speechTicket,
      answer,
      ipKey,
      env.OPENAI_API_KEY,
      new URL(request.url).hostname
    );
    if (!validTicket) {
      return jsonResponse({ error: "invalid_or_expired_speech_ticket" }, 403);
    }

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          voice: "onyx",
          input: answer,
          instructions: ROCKY_SPEECH_INSTRUCTIONS,
          response_format: "mp3",
          speed: 0.78
        })
      });
    } catch (error) {
      console.error("Rocky speech request failed:", error);
      return jsonResponse({ error: "voice_provider_unavailable" }, 502);
    }

    if (!response.ok || !response.body) {
      console.error("Rocky speech provider error status:", response.status);
      return jsonResponse({ error: "voice_provider_unavailable" }, 502);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        ...RESPONSE_HEADERS
      }
    });
  } catch (error) {
    console.error("Rocky voice error:", error);
    return jsonResponse({ error: "voice_unavailable" }, 500);
  }
}
