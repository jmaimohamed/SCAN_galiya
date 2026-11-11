import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../db";
import { audit } from "../audit";
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN } from "../auth/password";
import { normalizeUsername } from "../auth/login";
import { assertAdmin } from "../permissions";
import { adminReason } from "./administration";
import { badRequest, conflict, notFound, type Actor, type Role } from "../errors";

export const USERNAME_RE = /^[A-Z0-9][A-Z0-9._-]{1,31}$/;

export interface UserDto {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

function toDto(u: { id: string; username: string; displayName: string | null; role: Role; active: boolean; createdAt: Date; lastLoginAt: Date | null }): UserDto {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  };
}

export function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw badRequest(`Mot de passe : ${PASSWORD_MIN} à ${PASSWORD_MAX} caractères.`);
  }
}

export async function listUsers(): Promise<UserDto[]> {
  const users = await prisma.user.findMany({ orderBy: [{ active: "desc" }, { username: "asc" }] });
  return users.map(toDto);
}

/** Create a user. `actor` is null only for the bootstrap command (first administrator). */
export async function createUser(
  actor: Actor | null,
  input: { username: string; displayName: string | null; role: Role; password: string; reason?: string },
): Promise<UserDto> {
  if (actor) assertAdmin(actor);
  const reason = actor ? adminReason(input.reason ?? "") : "Création initiale administrateur";
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username)) throw badRequest("Identifiant : 2 à 32 caractères (A–Z, 0–9, point, tiret, souligné).");
  validatePassword(input.password);
  const passwordHash = await hashPassword(input.password);
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { username, displayName: input.displayName?.trim() || null, role: input.role, passwordHash } });
      await audit(tx, { type: "USER_CREATED", actor, username: actor ? undefined : "SYSTEM", details: { reason, target: user.id, before: null, after: { ...toDto(user) } } });
      return toDto(user);
    }, TX_OPTIONS);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw conflict("USERNAME_TAKEN", "Cet identifiant existe déjà.");
    }
    throw e;
  }
}

export async function updateUser(actor: Actor, userId: string, input: { active?: boolean; role?: Role; displayName?: string | null; reason?: string }): Promise<UserDto> {
  assertAdmin(actor);
  const reason = adminReason(input.reason ?? "");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(71920341)::text`;
    const target = await tx.user.findUnique({ where: { id: userId } });
    if (!target) throw notFound("Utilisateur introuvable.");
    const losesAdmin = target.role === "ADMIN" && target.active && (input.active === false || input.role !== undefined && input.role !== "ADMIN");
    if (losesAdmin && await tx.user.count({ where: { role: "ADMIN", active: true, id: { not: userId } } }) === 0) throw conflict("LAST_ADMIN", "Au moins un administrateur actif doit rester.");
    if (userId === actor.userId && (input.active === false || input.role && input.role !== "ADMIN")) throw badRequest("Vous ne pouvez pas désactiver ou rétrograder votre propre compte.");
    const user = await tx.user.update({ where: { id: userId }, data: {
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName?.trim() || null } : {}),
    } });
    if (input.active === false || input.role !== undefined && input.role !== target.role) await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, { type: "USER_UPDATED", actor, details: { reason, target: userId, before: { ...toDto(target) }, after: { ...toDto(user) } } });
    return toDto(user);
  }, TX_OPTIONS);
}

export async function resetPassword(actor: Actor, userId: string, password: string, reasonInput = ""): Promise<void> {
  assertAdmin(actor);
  const reason = adminReason(reasonInput);
  validatePassword(password);
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id: userId } });
    if (!target) throw notFound("Utilisateur introuvable.");
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, { type: "USER_PASSWORD_RESET", actor, details: { reason, target: userId, username: target.username, before: { credentials: "existants" }, after: { credentials: "renouvelés", sessionsRevoked: true } } });
  }, TX_OPTIONS);
}
