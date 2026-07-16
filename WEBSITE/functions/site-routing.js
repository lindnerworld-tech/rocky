export const CANONICAL_HOSTNAME = "www.rockyaloha.com";
export const APEX_HOSTNAME = "rockyaloha.com";

export function canonicalRedirectFor(url) {
  const target = url instanceof URL ? new URL(url) : new URL(url);
  if (target.hostname !== APEX_HOSTNAME) return null;

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
  const ready = Boolean(
    protectedByTurnstile && aiEnabled && env.OPENAI_API_KEY
  );

  return {
    status: ready ? 200 : 503,
    body: {
      status: ready ? "ok" : "degraded",
      service: "project-rocky",
      protected: protectedByTurnstile,
      aiEnabled
    }
  };
}
