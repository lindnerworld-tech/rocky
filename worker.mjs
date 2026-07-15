import { onRequestPost } from "./WEBSITE/functions/ask-rocky.js";

// Keep the already-migrated Durable Object class available while production
// continues to run the original Ask Rocky handler. The protection branch will
// use this binding after it passes staging acceptance checks.
export class RockyUsageLimiter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch() {
    return new Response("Not active", { status: 503 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ask-rocky") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { "Allow": "POST" }
        });
      }

      return onRequestPost({ request, env });
    }

    return env.ASSETS.fetch(request);
  }
};
