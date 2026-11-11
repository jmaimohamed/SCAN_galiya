/** Trusted-origin configuration (APP_TRUSTED_ORIGINS), shared by the server and proxy.ts. */
export const DEFAULT_TRUSTED_ORIGINS = ["http://localhost:3006", "http://localhost:3007", "http://127.0.0.1:3006", "http://127.0.0.1:3007"];

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseTrustedOrigins(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return DEFAULT_TRUSTED_ORIGINS;
  return raw
    .split(",")
    .map((v) => normalizeOrigin(v))
    .filter((v): v is string => v !== null);
}

/** host[:port] values allowed in the Host header. */
export function trustedHosts(raw: string | undefined): Set<string> {
  return new Set(parseTrustedOrigins(raw).map((o) => new URL(o).host.toLowerCase()));
}
