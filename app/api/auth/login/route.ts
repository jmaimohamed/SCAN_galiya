import type { NextRequest } from "next/server";
import { attemptLogin } from "@/lib/server/auth/login";
import { SESSION_COOKIE } from "@/lib/server/config";
import { AppError } from "@/lib/server/errors";
import { clientIp, jsonOk, publicApi, readJson, sessionCookieOptions } from "@/lib/server/http";
import { loginSchema } from "@/lib/server/schemas";

export const POST = publicApi(async (req: NextRequest) => {
  const body = await readJson(req, loginSchema);
  const result = await attemptLogin({
    username: body.username,
    password: body.password,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  if (!result.ok) {
    if (result.code === "RATE_LIMITED") {
      throw new AppError(429, "RATE_LIMITED", `Trop de tentatives. Réessayer dans ${result.retryAfterMinutes} minutes.`);
    }
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiant ou mot de passe incorrect.");
  }
  const res = jsonOk({ username: result.username });
  res.cookies.set(SESSION_COOKIE, result.token, sessionCookieOptions(req, result.expiresAt));
  return res;
});
