export const CANONICAL_HOSTNAME = "www.rockyaloha.com";
export const APEX_HOSTNAME = "rockyaloha.com";
const CANONICAL_ALIASES = new Set([
  APEX_HOSTNAME,
  "rockyaloha.org",
  "www.rockyaloha.org"
]);

export function canonicalRedirectFor(url) {
  const target = url instanceof URL ? new URL(url) : new URL(url);
  if (!CANONICAL_ALIASES.has(target.hostname)) return null;

  target.protocol = "https:";
  target.hostname = CANONICAL_HOSTNAME;
  target.port = "";
  return target.toString();
}

export function healthState(env) {
  const protectedByTurnstile = Boolean(
    env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
  );
  const aiEnabled = env.ROCKY_AI_ENABLED !== "false";
  const identityEnabled = env.ROCKY_IDENTITY_ENABLED === "true";
  const identityReady = !identityEnabled || Boolean(
    env.CLERK_PUBLISHABLE_KEY && env.CLERK_JWT_KEY && env.ROCKY_DB
  );
  const paymentsEnabled = env.ROCKY_PAYMENTS_ENABLED === "true";
  const liveSourceAllowlistReady = env.PADDLE_ENVIRONMENT === "sandbox" ||
    Boolean(env.PADDLE_API_KEY);
  const paymentsReady = !paymentsEnabled || Boolean(
    liveSourceAllowlistReady &&
    env.PADDLE_CLIENT_TOKEN &&
    env.PADDLE_MONTHLY_PRICE_ID &&
    env.PADDLE_ANNUAL_PRICE_ID &&
    env.PADDLE_WEBHOOK_SECRET &&
    env.ROCKY_CHECKOUT_SECRET &&
    env.ROCKY_DB
  );
  const ready = Boolean(
    protectedByTurnstile &&
    aiEnabled &&
    env.OPENAI_API_KEY &&
    identityReady &&
    paymentsReady
  );

  return {
    status: ready ? 200 : 503,
    body: {
      status: ready ? "ok" : "degraded",
      service: "project-rocky",
      protected: protectedByTurnstile,
      aiEnabled,
      identityEnabled,
      identityReady,
      paymentsEnabled,
      paymentsReady
    }
  };
}
