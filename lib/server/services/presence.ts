import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { config } from "../config";
import { assertAdmin } from "../permissions";
import { conflict, type Actor } from "../errors";
export const HEARTBEAT_EXPIRY_MS = 75_000;
export const IDLE_ACTIVITY_MS = 120_000;

export async function heartbeat(actor: Actor, input: { tabId: string; workstationId: string | null; boxId: string | null; active: boolean }) {
  const now = new Date();
  const box = input.boxId ? await prisma.box.findFirst({ where: { id: input.boxId, ownerSessionId: actor.sessionId, activeAttemptId: { not: null } }, select: { id: true } }) : null;
  const saved = await prisma.$queryRaw<{ tabId: string }[]>`
    INSERT INTO "BrowserPresence" ("tabId", "sessionId", "workstationId", "boxId", "heartbeatAt", "activityAt")
    VALUES (${input.tabId}::uuid, ${actor.sessionId}, ${input.workstationId}::uuid, ${box?.id ?? null}::uuid, ${now}, ${now})
    ON CONFLICT ("tabId") DO UPDATE SET "workstationId" = EXCLUDED."workstationId", "boxId" = EXCLUDED."boxId",
      "heartbeatAt" = EXCLUDED."heartbeatAt", "activityAt" = CASE WHEN ${input.active} THEN EXCLUDED."activityAt" ELSE "BrowserPresence"."activityAt" END
    WHERE "BrowserPresence"."sessionId" = EXCLUDED."sessionId" RETURNING "tabId"`;
  if (!saved.length) throw conflict("PRESENCE_TAB", "Identifiant d'onglet déjà utilisé.");
  return { ok: true };
}

type PresenceRow = { username: string; workstation: string | null; boxSerial: string | null; heartbeatAt: Date; activityAt: Date; state: "ONLINE" | "IDLE" | "OFFLINE" };
function presenceGroups(now: Date) {
  return Prisma.sql`WITH groups AS (
    SELECT u."username", p."workstationId", max(w."name") AS workstation,
      (array_agg(b."boxSerial" ORDER BY p."heartbeatAt" DESC) FILTER (WHERE b."boxSerial" IS NOT NULL AND p."heartbeatAt" > ${new Date(now.getTime() - HEARTBEAT_EXPIRY_MS)}))[1] AS "boxSerial",
      max(p."heartbeatAt") AS "heartbeatAt", max(p."activityAt") AS "activityAt"
    FROM "BrowserPresence" p JOIN "Session" s ON s."id" = p."sessionId" JOIN "User" u ON u."id" = s."userId"
    LEFT JOIN "PrinterProfile" w ON w."workstationId" = p."workstationId"
    LEFT JOIN "Box" b ON b."id" = p."boxId" AND b."ownerSessionId" = s."id" AND b."activeAttemptId" IS NOT NULL
    WHERE u."active" AND u."role" = 'OPERATOR' AND s."revokedAt" IS NULL AND s."expiresAt" > ${now}
      AND s."lastSeenAt" > ${new Date(now.getTime() - config.sessionIdleMinutes() * 60000)}
      AND p."heartbeatAt" > ${new Date(now.getTime() - 86400000)}
    GROUP BY u."username", p."workstationId"
  ), states AS (SELECT *, CASE WHEN "heartbeatAt" <= ${new Date(now.getTime() - HEARTBEAT_EXPIRY_MS)} THEN 'OFFLINE'
    WHEN "activityAt" <= ${new Date(now.getTime() - IDLE_ACTIVITY_MS)} THEN 'IDLE' ELSE 'ONLINE' END AS state FROM groups)`;
}
export async function presencePage(actor: Actor, input: { state?: string; page?: number } = {}, now = new Date()) {
  assertAdmin(actor);
  const filter = input.state === "ACTIVE" ? Prisma.sql`WHERE state <> 'OFFLINE'` : ["ONLINE", "IDLE", "OFFLINE"].includes(input.state ?? "") ? Prisma.sql`WHERE state = ${input.state}` : Prisma.empty;
  const groups = presenceGroups(now);
  const [count] = await prisma.$queryRaw<{ total: bigint }[]>`${groups} SELECT count(*) AS total FROM states ${filter}`;
  const total = Number(count.total); const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(pageCount, Math.max(1, Math.floor(input.page ?? 1) || 1));
  const rows = await prisma.$queryRaw<PresenceRow[]>`${groups} SELECT * FROM states ${filter} ORDER BY "heartbeatAt" DESC, "username", "workstationId" LIMIT 25 OFFSET ${(page - 1) * 25}`;
  return { rows: rows.map((r) => ({ username: r.username, workstation: r.workstation, boxSerial: r.boxSerial, lastActivity: r.activityAt.toISOString(), lastHeartbeat: r.heartbeatAt.toISOString(), state: r.state })), total, page, pageCount };
}
export async function listPresence(actor: Actor, now = new Date()) { return (await presencePage(actor, {}, now)).rows; }
export async function connectedOperatorCount(actor: Actor, now = new Date()) {
  assertAdmin(actor);
  const [row] = await prisma.$queryRaw<{ total: bigint }[]>`${presenceGroups(now)} SELECT count(DISTINCT "username") AS total FROM states WHERE state <> 'OFFLINE'`;
  return Number(row.total);
}
