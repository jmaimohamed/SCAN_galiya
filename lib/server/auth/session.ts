import "server-only";
import { prisma } from "../db";
import { config } from "../config";
import { randomToken, sha256Hex } from "../crypto";
import type { Actor } from "../errors";

/**
 * Database-backed sessions. The cookie holds a random 256-bit token; only its
 * SHA-256 is stored. Every request re-checks expiry, idle time, revocation and
 * that the user is still active — disabling a user ends their sessions at once.
 */
export async function createSession(userId: string, meta: { ip: string; userAgent: string | null }) {
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlHours() * 3600_000);
  await prisma.session.create({
    data: {
      id: sha256Hex(token),
      userId,
      expiresAt,
      lastSeenAt: now,
      ip: meta.ip.slice(0, 64),
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
    },
  });
  return { token, expiresAt };
}

export async function validateSessionToken(token: string | undefined | null): Promise<Actor | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const id = sha256Hex(token);
  const session = await prisma.session.findUnique({ where: { id }, include: { user: true } });
  if (!session) return null;
  const now = Date.now();
  const idleLimit = config.sessionIdleMinutes() * 60_000;
  if (
    session.revokedAt ||
    session.expiresAt.getTime() <= now ||
    session.lastSeenAt.getTime() + idleLimit <= now ||
    !session.user.active
  ) {
    return null;
  }
  if (now - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id }, data: { lastSeenAt: new Date(now) } });
  }
  return {
    userId: session.user.id,
    username: session.user.username,
    displayName: session.user.displayName,
    role: session.user.role,
    sessionId: session.id,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
