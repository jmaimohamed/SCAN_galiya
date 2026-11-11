import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { assertAdmin } from "../permissions";
import type { Actor } from "../errors";
import { plantDayStartUtc } from "@/lib/time";
import { listPresence, connectedOperatorCount } from "./presence";

export const ADMIN_PAGE_SIZE = 25;
export type DashboardStatus = "ALL" | "COMPLETED" | "OK" | "NOK" | "IN_PROGRESS" | "RECONTROL" | "ARCHIVED";
export interface DashboardFilters { from: string; to: string; operator: string; pn: string; status: DashboardStatus; page: number }

export function dashboardFilters(p: Record<string, string | string[] | undefined>): DashboardFilters {
  const get = (k: string) => typeof p[k] === "string" ? p[k] as string : "";
  const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && plantDayStartUtc(s) ? s : "";
  const states = ["ALL", "COMPLETED", "OK", "NOK", "IN_PROGRESS", "RECONTROL", "ARCHIVED"];
  return { from: day(get("from")), to: day(get("to")), operator: get("operator").trim().toUpperCase().slice(0, 32), pn: get("pn").trim().toUpperCase().slice(0, 40), status: states.includes(get("status")) ? get("status") as DashboardStatus : "ALL", page: Math.max(1, Math.min(1000000, parseInt(get("page"), 10) || 1)) };
}

export function currentStateWhere(status: DashboardStatus): Prisma.BoxWhereInput {
  if (status === "RECONTROL") return { needsRecontrol: true };
  if (status === "IN_PROGRESS") return { needsRecontrol: false, activeAttemptId: { not: null } };
  if (["OK", "NOK", "COMPLETED"].includes(status)) return { needsRecontrol: false, activeAttemptId: null, currentReportId: { not: null }, ...(status === "COMPLETED" ? {} : { status: status as "OK" | "NOK" }) };
  return {};
}

export async function administrationDashboard(actor: Actor, f: DashboardFilters) {
  assertAdmin(actor);
  const from = f.from ? plantDayStartUtc(f.from) : null;
  const end = f.to ? plantDayStartUtc(f.to) : null;
  const date = { ...(from ? { gte: from } : {}), ...(end ? { lt: new Date(end.getTime() + 86400000) } : {}) };
  const op = f.operator ? await prisma.user.findUnique({ where: { username: f.operator }, select: { id: true } }) : null;
  const and: Prisma.BoxWhereInput[] = [{ partNumber: { startsWith: f.pn } }];
  if (from || end) and.push({ OR: [
    { AND: [currentStateWhere("COMPLETED"), { finalizedAt: date }] },
    { AND: [{ OR: [{ activeAttemptId: { not: null } }, { needsRecontrol: true }, { currentReportId: null }] }, { generationStartedAt: date }] },
  ] });
  if (f.operator) and.push(op ? { OR: [{ ownerUserId: op.id }, { AND: [currentStateWhere("COMPLETED"), { finalizedById: op.id }] }, { activeAttempt: { startedById: op.id } }] } : { id: "00000000-0000-0000-0000-000000000000" });
  const base: Prisma.BoxWhereInput = { AND: and };
  const statuses = ["COMPLETED", "OK", "NOK", "IN_PROGRESS", "RECONTROL"] as const;
  const [counts, archivedCount, presence, onlineOperators] = await Promise.all([
    Promise.all(statuses.map((s) => prisma.box.count({ where: { AND: [base, currentStateWhere(s)] } }))),
    prisma.controlGeneration.count({ where: { voidedAt: { not: null, ...date }, partNumber: { startsWith: f.pn }, ...(f.operator ? { voidedById: op?.id ?? "00000000-0000-0000-0000-000000000000" } : {}) } }),
    listPresence(actor),
    connectedOperatorCount(actor),
  ]);
  const where: Prisma.BoxWhereInput = { AND: [base, currentStateWhere(f.status)] };
  const archiveWhere: Prisma.ControlGenerationWhereInput = { voidedAt: { not: null, ...date }, partNumber: { startsWith: f.pn }, ...(f.operator ? { voidedById: op?.id ?? "00000000-0000-0000-0000-000000000000" } : {}) };
  const total = f.status === "ARCHIVED" ? archivedCount : await prisma.box.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const page = Math.min(f.page, pageCount);
  const [boxes, archived] = await Promise.all([
    f.status === "ARCHIVED" ? [] : prisma.box.findMany({ where, orderBy: [{ generationStartedAt: "desc" }, { id: "asc" }], take: ADMIN_PAGE_SIZE, skip: (page - 1) * ADMIN_PAGE_SIZE, include: { _count: { select: { reservations: true } }, finalizedBy: { select: { username: true } }, activeAttempt: { select: { startedBy: { select: { username: true } } } } } }),
    f.status === "ARCHIVED" ? prisma.controlGeneration.findMany({ where: archiveWhere, orderBy: [{ voidedAt: "desc" }, { id: "asc" }], take: ADMIN_PAGE_SIZE, skip: (page - 1) * ADMIN_PAGE_SIZE }) : [],
  ]);
  return {
    metrics: { completed: counts[0], ok: counts[1], nok: counts[2], inProgress: counts[3], recontrol: counts[4], archived: archivedCount, onlineOperators },
    rows: boxes.map((b) => ({ id: b.id, serial: b.boxSerial, pn: b.partNumber, generation: b.generation, expectedQty: b.expectedQty, acceptedQty: b._count.reservations, status: b.needsRecontrol ? "RECONTROL" : b.activeAttemptId ? "IN_PROGRESS" : b.status, operator: b.finalizedBy?.username ?? b.activeAttempt?.startedBy.username ?? null, finalizedAt: b.finalizedAt?.toISOString() ?? null })),
    archived: archived.map((g) => ({ ...g, startedAt: g.startedAt.toISOString(), voidedAt: g.voidedAt!.toISOString() })),
    presence, total, page, pageCount,
  };
}
