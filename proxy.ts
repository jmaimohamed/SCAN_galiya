import { NextResponse, type NextRequest } from "next/server";
import { trustedHosts } from "@/lib/origins";

/**
 * Host allow-list + security headers.
 * Only hosts listed in APP_TRUSTED_ORIGINS are served (421 otherwise), so the
 * application never relies on an arbitrary Host header. Authentication is NOT
 * decided here — every page and API route checks the session on the server.
 */
const isDev = process.env.NODE_ENV !== "production";

// The label print view (/etiquette/<job>) is loaded in a same-origin frame and printed
// with window.print(): framing is allowed for this origin only.
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function proxy(request: NextRequest) {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (!trustedHosts(process.env.APP_TRUSTED_ORIGINS).has(host)) {
    return new NextResponse(
      `Hôte non autorisé : ${host || "(vide)"}.\nAjouter l'adresse exacte (ex. http://${host || "serveur:3006"}) à APP_TRUSTED_ORIGINS dans .env puis redémarrer.`,
      { status: 421, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", CSP);
  response.headers.set("X-Frame-Options", "SAMEORIGIN");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
