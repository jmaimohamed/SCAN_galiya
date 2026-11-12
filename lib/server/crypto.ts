import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Stable UUID derived from a name (SHA-256 based, RFC 4122 v5-style layout).
 * Used as the idempotency key of the automatic print request of one report, so
 * any retry of the same end request yields the same print job.
 */
export function nameUuid(name: string): string {
  const h = createHash("sha256").update(`galia-control:${name}`, "utf8").digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** 256-bit random token, base64url (cookie / lease tokens). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function safeEqualHex(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
