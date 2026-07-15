import test from "node:test";
import assert from "node:assert/strict";

import { onRequestPost } from "../WEBSITE/functions/ask-rocky.js";

function makeRequest(body, headers = {}) {
  return new Request("https://rocky.test/ask-rocky", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function makeEnv(overrides = {}) {
  return {
    ROCKY_AI_ENABLED: "true",
    OPENAI_API_KEY: "test-openai-key",
    TURNSTILE_SITE_KEY: "test-site-key",
    TURNSTILE_SECRET_KEY: "test-secret-key",
    ROCKY_DAILY_IP_LIMIT: "3",
    ROCKY_GLOBAL_DAILY_LIMIT: "500",
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
    USAGE_LIMITER: {
      getByName() {
        return {
          async consume() {
            return { allowed: true };
          }
        };
      }
    },
    ...overrides
  };
}

async function responseJson(response) {
  return {
    status: response.status,
    body: await response.json()
  };
}

test("returns a protected Rocky answer", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));

    if (String(url).includes("turnstile")) {
      return Response.json({
        success: true,
        hostname: "rocky.test",
        action: "ask_rocky"
      });
    }

    return Response.json({
      output: [
        {
          content: [
            {
              type: "output_text",
              text: "A wave does not argue with the shore. It adjusts and returns."
            }
          ]
        }
      ]
    });
  };

  const result = await responseJson(await onRequestPost({
    request: makeRequest({
      question: "What should I do next?",
      category: "life",
      turnstileToken: "valid-token"
    }),
    env: makeEnv()
  }));

  assert.equal(result.status, 200);
  assert.match(result.body.answer, /wave/i);
  assert.equal(calls.length, 2);
});

test("kill switch stops requests before any provider call", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not run");
  };

  const result = await responseJson(await onRequestPost({
    request: makeRequest({
      question: "Hello?",
      turnstileToken: "valid-token"
    }),
    env: makeEnv({ ROCKY_AI_ENABLED: "false" })
  }));

  assert.equal(result.status, 503);
  assert.equal(called, false);
});

test("burst limiter returns 429 before Turnstile or OpenAI", async () => {
  const result = await responseJson(await onRequestPost({
    request: makeRequest({
      question: "Hello?",
      turnstileToken: "valid-token"
    }),
    env: makeEnv({
      IP_RATE_LIMITER: {
        async limit() {
          return { success: false };
        }
      }
    })
  }));

  assert.equal(result.status, 429);
  assert.equal(result.body.answer, "Too many waves at once. Give Rocky a minute.");
});

test("missing Turnstile configuration fails closed", async () => {
  const result = await responseJson(await onRequestPost({
    request: makeRequest({
      question: "Hello?",
      turnstileToken: "valid-token"
    }),
    env: makeEnv({ TURNSTILE_SECRET_KEY: "" })
  }));

  assert.equal(result.status, 503);
  assert.match(result.body.answer, /safety check/i);
});

test("invalid Turnstile token is rejected", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => Response.json({
    success: false,
    hostname: "rocky.test",
    action: "ask_rocky",
    "error-codes": ["invalid-input-response"]
  });

  const result = await responseJson(await onRequestPost({
    request: makeRequest({
      question: "Hello?",
      turnstileToken: "invalid-token"
    }),
    env: makeEnv()
  }));

  assert.equal(result.status, 403);
  assert.match(result.body.answer, /could not verify/i);
});

test("daily limit blocks OpenAI after successful verification", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let providerCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).includes("turnstile")) {
      return Response.json({
        success: true,
        hostname: "rocky.test",
        action: "ask_rocky"
      });
    }

    providerCalls += 1;
    return Response.json({});
  };

  const result = await responseJson(await onRequestPost({
    request: makeRequest({
      question: "One more?",
      turnstileToken: "valid-token"
    }),
    env: makeEnv({
      USAGE_LIMITER: {
        getByName() {
          return {
            async consume() {
              return { allowed: false, reason: "ip_daily_limit" };
            }
          };
        }
      }
    })
  }));

  assert.equal(result.status, 429);
  assert.equal(providerCalls, 0);
  assert.match(result.body.answer, /tomorrow/i);
});

test("oversized body is rejected", async () => {
  const result = await responseJson(await onRequestPost({
    request: makeRequest({
      question: "short",
      padding: "x".repeat(5000),
      turnstileToken: "valid-token"
    }),
    env: makeEnv()
  }));

  assert.equal(result.status, 413);
});
