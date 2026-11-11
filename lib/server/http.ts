import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { SESSION_COOKIE, isTrustedOrigin } from "./config";
import { validateSessionToken } from "./auth/session";
import { AppError, badRequest, forbidden, unauthenticated, type Actor, type Role } from "./errors";

const MAX_JSON_BYTES = 16 * 1024;

export function jsonError(e: AppError): NextResponse {
  return NextResponse.json(
    { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } },
    { status: e.status, headers: { "Cache-Control": "no-store" } },
  );
}

export function jsonOk(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** Best-effort client address for rate limiting and audit (proxy headers are not trusted for identity). */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64) || "unknown";
  return req.headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}

/**
 * CSRF / origin protection for state-changing requests: the Origin header must
 * be one of the explicitly configured trusted origins (APP_TRUSTED_ORIGINS).
 * Cross-site fetch metadata is rejected as well.
 */
export function assertTrustedOrigin(req: NextRequest): void {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw forbidden("Requête inter-site refusée.");
  if (!isTrustedOrigin(req.headers.get("origin"))) {
    throw forbidden("Origine non autorisée. Vérifier APP_TRUSTED_ORIGINS pour cette adresse.");
  }
}

export async function actorFromRequest(req: NextRequest): Promise<Actor | null> {
  return validateSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
}

export async function readJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) throw badRequest("Corps JSON attendu.");
  const text = await req.text();
  if (text.length > MAX_JSON_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "Requête trop volumineuse.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw badRequest("JSON invalide.");
  }
  return schema.parse(body);
}

interface ApiOptions {
  /** Default true. Login is the only unauthenticated mutation. */
  auth?: boolean;
  role?: Role;
}

type Handler<C> = (req: NextRequest, ctx: C & { actor: Actor }) => Promise<Response>;
type PublicHandler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

function toResponse(e: unknown): Response {
  if (e instanceof AppError) return jsonError(e);
  if (e instanceof ZodError) {
    return jsonError(badRequest("Données invalides.", { issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }));
  }
  // Unexpected failure: log the error type/message only (never request bodies or credentials).
  console.error("[api] unexpected error:", e instanceof Error ? `${e.name}: ${e.message}` : "unknown");
  return jsonError(new AppError(500, "INTERNAL", "Erreur serveur — réessayer. Si le problème persiste, prévenir l'administrateur."));
}

/** Authenticated API route: session + role + trusted origin for mutations. */
export function api<C extends object>(handler: Handler<C>, options: ApiOptions & { auth?: true } = {}) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertTrustedOrigin(req);
      const actor = await actorFromRequest(req);
      if (!actor) throw unauthenticated();
      if (options.role === "ADMIN" && actor.role !== "ADMIN") throw forbidden();
      return await handler(req, { ...ctx, actor });
    } catch (e) {
      return toResponse(e);
    }
  };
}

/** Unauthenticated API route (login only). Still origin-checked for mutations. */
export function publicApi<C extends object>(handler: PublicHandler<C>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertTrustedOrigin(req);
      return await handler(req, ctx);
    } catch (e) {
      return toResponse(e);
    }
  };
}

/** Session cookie: HttpOnly, SameSite=Strict, Secure when the trusted origin is HTTPS. */
export function sessionCookieOptions(req: NextRequest, expires: Date) {
  const origin = req.headers.get("origin") ?? "";
  const forced = process.env.SESSION_COOKIE_SECURE;
  const secure = forced === "true" ? true : forced === "false" ? false : origin.startsWith("https://");
  return { httpOnly: true, sameSite: "strict" as const, secure, path: "/", expires };
}
