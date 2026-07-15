import { onRequestPost } from "./WEBSITE/functions/ask-rocky.js";

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
