import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createSpeechTicket,
  onRequestSpeakRocky,
  publicVoiceConfiguration,
  verifySpeechTicket
} from "../WEBSITE/functions/rocky-voice.js";

const OPENAI_API_KEY = "test-openai-key";
const REMOTE_IP = "203.0.113.10";
const ANSWER = "The tide does not need permission to turn. Take the next honest step.";

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

function makeEnv(overrides = {}) {
  return {
    ROCKY_VOICE_ENABLED: "true",
    OPENAI_API_KEY,
    IP_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    },
    GLOBAL_RATE_LIMITER: {
      async limit() {
        return { success: true };
      }
    },
    ...overrides
  };
}

function makeRequest(body) {
  return new Request("https://rocky.test/speak-rocky", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": REMOTE_IP
    },
    body: JSON.stringify(body)
  });
}

test("speech tickets are short-lived and bound to both answer and visitor", async () => {
  const ipKey = await hashIdentifier(REMOTE_IP);
  const ticket = await createSpeechTicket(
    ANSWER,
    ipKey,
    OPENAI_API_KEY,
    "rocky.test",
    1_000
  );

  assert.equal(
    await verifySpeechTicket(ticket, ANSWER, ipKey, OPENAI_API_KEY, "rocky.test", 1_001),
    true
  );
  assert.equal(
    await verifySpeechTicket(ticket, `${ANSWER} Extra`, ipKey, OPENAI_API_KEY, "rocky.test", 1_001),
    false
  );
  assert.equal(
    await verifySpeechTicket(ticket, ANSWER, "different-visitor", OPENAI_API_KEY, "rocky.test", 1_001),
    false
  );
  assert.equal(
    await verifySpeechTicket(ticket, ANSWER, ipKey, OPENAI_API_KEY, "rocky.test", 1_301),
    false
  );
  assert.equal(
    await verifySpeechTicket(ticket, ANSWER, ipKey, OPENAI_API_KEY, "other.test", 1_001),
    false
  );
});

test("speaks a signed Rocky answer with the approved model and voice", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const ipKey = await hashIdentifier(REMOTE_IP);
  const speechTicket = await createSpeechTicket(
    ANSWER,
    ipKey,
    OPENAI_API_KEY,
    "rocky.test"
  );
  let providerRequest;
  globalThis.fetch = async (url, options) => {
    providerRequest = {
      url: String(url),
      authorization: options.headers.Authorization,
      body: JSON.parse(options.body)
    };
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]));
  };

  const response = await onRequestSpeakRocky({
    request: makeRequest({ answer: ANSWER, speechTicket }),
    env: makeEnv()
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "audio/mpeg");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(
    [...new Uint8Array(await response.arrayBuffer())],
    [0x49, 0x44, 0x33, 0x04]
  );
  assert.equal(providerRequest.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(providerRequest.authorization, `Bearer ${OPENAI_API_KEY}`);
  assert.equal(providerRequest.body.model, "gpt-4o-mini-tts");
  assert.equal(providerRequest.body.voice, "cedar");
  assert.equal(providerRequest.body.input, ANSWER);
  assert.equal(providerRequest.body.response_format, "mp3");
  assert.match(providerRequest.body.instructions, /low, warm, grounded/i);
  assert.match(providerRequest.body.instructions, /do not imitate Hawaiian, local, or pidgin/i);
});

test("rejects a changed answer before calling the speech provider", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let providerCalled = false;
  globalThis.fetch = async () => {
    providerCalled = true;
    throw new Error("provider should not be called");
  };

  const ipKey = await hashIdentifier(REMOTE_IP);
  const speechTicket = await createSpeechTicket(
    ANSWER,
    ipKey,
    OPENAI_API_KEY,
    "rocky.test"
  );
  const response = await onRequestSpeakRocky({
    request: makeRequest({ answer: `${ANSWER} Extra`, speechTicket }),
    env: makeEnv()
  });

  assert.equal(response.status, 403);
  assert.equal(providerCalled, false);
  assert.equal((await response.json()).error, "invalid_or_expired_speech_ticket");
});

test("voice kill switch and burst protection fail closed", async () => {
  const disabled = await onRequestSpeakRocky({
    request: makeRequest({ answer: ANSWER, speechTicket: "unused" }),
    env: makeEnv({ ROCKY_VOICE_ENABLED: "false" })
  });
  const limited = await onRequestSpeakRocky({
    request: makeRequest({ answer: ANSWER, speechTicket: "unused" }),
    env: makeEnv({
      IP_RATE_LIMITER: {
        async limit() {
          return { success: false };
        }
      }
    })
  });

  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error, "voice_disabled");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
});

test("public voice configuration exposes no credential", () => {
  assert.deepEqual(publicVoiceConfiguration({
    ROCKY_VOICE_ENABLED: "true",
    OPENAI_API_KEY
  }), {
    enabled: true,
    ready: true,
    disclosure: "AI-generated voice"
  });
  assert.deepEqual(publicVoiceConfiguration({
    ROCKY_VOICE_ENABLED: "false",
    OPENAI_API_KEY
  }), {
    enabled: false,
    ready: false,
    disclosure: "AI-generated voice"
  });
});

test("homepage provides a disclosed, user-initiated voice control", async () => {
  const html = await readFile(
    new URL("../WEBSITE/index.html", import.meta.url),
    "utf8"
  );
  const worker = await readFile(
    new URL("../worker.mjs", import.meta.url),
    "utf8"
  );

  assert.match(html, /id="hearRockyButton"/);
  assert.match(html, /AI-generated voice\./);
  assert.match(html, /fetch\("\/speak-rocky"/);
  assert.match(html, /speechTicket: latestSpeechTicket/);
  assert.doesNotMatch(html, /OPENAI_API_KEY/);
  assert.match(worker, /url\.pathname === "\/speak-rocky"/);
  assert.match(worker, /Allow: "POST"/);
});

test("voice is staging-only while production remains disabled", async () => {
  const source = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );
  const config = JSON.parse(source.replace(/^\uFEFF/, ""));

  assert.equal(
    publicVoiceConfiguration(config.vars).enabled,
    false
  );
  assert.equal(
    publicVoiceConfiguration(config.env.staging.vars).enabled,
    true
  );
  assert.equal(config.vars.ROCKY_PAYMENTS_ENABLED, "false");
});
