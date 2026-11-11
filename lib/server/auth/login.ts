import "server-only";
import { prisma } from "../db";
import { config } from "../config";
import { audit } from "../audit";
import { burnPasswordCheck, verifyPassword } from "./password";
import { createSession } from "./session";

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; username: string }
  | { ok: false; code: "INVALID_CREDENTIALS" | "RATE_LIMITED"; retryAfterMinutes?: number };

/** User IDs are case-insensitive and stored upper-case. */
export function normalizeUsername(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Password login with failure-based rate limiting per user ID and per client IP
 * (counted in the database, so the limit survives restarts). The same generic
 * message is returned for unknown users, disabled users and wrong passwords.
 */
export async function attemptLogin(input: {
  username: string;
  password: string;
  ip: string;
  userAgent: string | null;
}): Promise<LoginResult> {
  const username = normalizeUsername(input.username).slice(0, 64);
  const ip = input.ip.slice(0, 64);
  const windowMs = config.loginWindowMinutes() * 60_000;
  const windowStart = new Date(Date.now() - windowMs);

  const lastSuccess = await prisma.loginAttempt.findFirst({
    where: { username, success: true, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const userSince = lastSuccess && lastSuccess.createdAt > windowStart ? lastSuccess.createdAt : windowStart;
  const [userFailures, ipFailures] = await Promise.all([
    prisma.loginAttempt.count({ where: { username, success: false, createdAt: { gt: userSince } } }),
    prisma.loginAttempt.count({ where: { ip, success: false, createdAt: { gte: windowStart } } }),
  ]);
  if (userFailures >= config.loginMaxFailuresPerUser() || ipFailures >= config.loginMaxFailuresPerIp()) {
    await audit(prisma, { type: "LOGIN_RATE_LIMITED", username, details: { ip } });
    return { ok: false, code: "RATE_LIMITED", retryAfterMinutes: config.loginWindowMinutes() };
  }

  const user = await prisma.user.findUnique({ where: { username } });
  let valid = false;
  if (user && user.active) {
    valid = await verifyPassword(user.passwordHash, input.password);
  } else {
    await burnPasswordCheck(input.password);
  }
  await prisma.loginAttempt.create({ data: { username, ip, success: valid } });

  if (!valid || !user) {
    await audit(prisma, { type: "LOGIN_FAILED", username, details: { ip } });
    return { ok: false, code: "INVALID_CREDENTIALS" };
  }

  const session = await createSession(user.id, { ip, userAgent: input.userAgent });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(prisma, { type: "LOGIN_SUCCESS", username: user.username, details: { ip } });
  return { ok: true, token: session.token, expiresAt: session.expiresAt, username: user.username };
}
