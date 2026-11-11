import "server-only";
import { normalizeOrigin, parseTrustedOrigins } from "../origins";

/**
 * Runtime configuration (server only). Nothing here is ever sent to the browser.
 *
 * APP_TRUSTED_ORIGINS — comma-separated list of exact origins the app is served
 * from (scheme://host:port). Mutating requests must carry one of these in their
 * Origin header, and pages are only served for these hosts (proxy.ts). Example:
 *   APP_TRUSTED_ORIGINS="http://localhost:3006,http://localhost:3007,https://galia-srv.lear.local:3443"
 */
export { normalizeOrigin };

export function trustedOrigins(): string[] {
  return parseTrustedOrigins(process.env.APP_TRUSTED_ORIGINS);
}

export function isTrustedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return normalized !== null && trustedOrigins().includes(normalized);
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

export const config = {
  /** Absolute session lifetime. */
  sessionTtlHours: () => intEnv("SESSION_TTL_HOURS", 12, 1, 72),
  /** Session idle timeout. */
  sessionIdleMinutes: () => intEnv("SESSION_IDLE_MINUTES", 120, 5, 24 * 60),
  /** Failed logins allowed per user ID / per IP within the window. */
  loginMaxFailuresPerUser: () => intEnv("LOGIN_MAX_FAILURES_PER_USER", 5, 1, 100),
  loginMaxFailuresPerIp: () => intEnv("LOGIN_MAX_FAILURES_PER_IP", 20, 1, 1000),
  loginWindowMinutes: () => intEnv("LOGIN_WINDOW_MINUTES", 15, 1, 1440),
};

export const SESSION_COOKIE = "galia_session";
