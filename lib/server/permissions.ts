import "server-only";
import { prisma } from "./db";
import { conflict, forbidden, notFound, type Actor } from "./errors";

export function assertAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") throw forbidden("Administration réservée aux administrateurs.");
}

/** A raw GALIA scan grants a focused box view; it grants no unrestricted history. */
export async function assertBoxAccess(actor: Actor, boxId: string): Promise<void> {
  if (actor.role === "ADMIN") return;
  const box = await prisma.box.findUnique({ where: { id: boxId }, select: { createdById: true, ownerUserId: true, controlAttempts: { where: { startedById: actor.userId }, take: 1, select: { id: true } } } });
  if (!box) throw notFound("Boîte introuvable.");
  if (box.createdById === actor.userId || box.ownerUserId === actor.userId || box.controlAttempts.length) return;
  const scanned = await prisma.auditEvent.findFirst({ where: { boxId, userId: actor.userId, type: { in: ["BOX_VIEWED_FINALIZED", "BOX_CORRECTION_OFFERED"] } }, select: { id: true } });
  if (!scanned) throw forbidden("Scanner d'abord la GALIA de cette boîte pour accéder à son contrôle.");
}

export async function assertReportAccess(actor: Actor, reportId: string): Promise<void> {
  const report = await prisma.report.findUnique({ where: { id: reportId }, select: { boxId: true, box: { select: { currentReportId: true } } } });
  if (!report) throw notFound("Rapport introuvable.");
  await assertBoxAccess(actor, report.boxId);
  if (actor.role !== "ADMIN" && report.box.currentReportId !== reportId) throw conflict(report.box.currentReportId ? "REPORT_SUPERSEDED" : "CONTROL_INVALIDATED", "Rapport remplacé ou invalidé : audit administrateur uniquement. Actualiser le contrôle courant.");
}
