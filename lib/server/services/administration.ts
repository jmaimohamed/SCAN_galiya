import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../db";
import { audit } from "../audit";
import { badRequest, conflict, notFound, type Actor } from "../errors";
import { assertAdmin } from "../permissions";
import { parseBoxLabel } from "@/lib/barcode";

export function adminReason(reason: string): string {
  const value = reason.trim();
  if (value.length < 3 || value.length > 500) throw badRequest("Motif administratif obligatoire (3 à 500 caractères).");
  return value;
}

async function context(tx: Prisma.TransactionClient, actor: Actor, reason: string, boxId: string) {
  assertAdmin(actor);
  await tx.$queryRaw`SELECT set_config('galia.admin_session', ${actor.sessionId}, true), set_config('galia.admin_reason', ${reason}, true)`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Box" WHERE "id" = ${boxId}::uuid FOR UPDATE`;
  if (!rows.length) throw notFound("Boîte introuvable.");
  return tx.box.findUniqueOrThrow({ where: { id: boxId } });
}

/** One-way void; the reservation trigger releases only this item's assignment. */
export async function voidAcceptedItem(actor: Actor, input: { boxId: string; itemId: string; reason: string; confirmSerial: string }) {
  assertAdmin(actor);
  const reason = adminReason(input.reason);
  return prisma.$transaction(async (tx) => {
    const before = await context(tx, actor, reason, input.boxId);
    const item = await tx.acceptedItem.findUnique({ where: { id: input.itemId }, include: { reservation: true } });
    if (!item || item.boxId !== before.id) throw notFound("Coiffe introuvable dans cette boîte.");
    if (item.serial !== input.confirmSerial) throw badRequest("Confirmer la série exacte de la coiffe.");
    if (item.voidedAt || !item.reservation || item.generation !== before.generation) throw conflict("ITEM_ALREADY_VOID", "Cette affectation n'est plus active. Actualiser les détails.");
    await tx.acceptedItem.update({ where: { id: item.id }, data: { voidedAt: new Date(), voidedById: actor.userId, voidReason: reason } });
    // During a correction, the current owner can continue with the refreshed count.
    // A closed box waits for a new audited recontrol attempt on its next GALIA scan.
    const after = await tx.box.update({ where: { id: before.id }, data: { status: "IN_PROGRESS", currentReportId: null, needsRecontrol: true, finalizedAt: null, finalizedById: null } });
    const acceptedQty = await tx.activeSerialReservation.count({ where: { boxId: before.id } });
    await audit(tx, { type: "ADMIN_ITEM_VOIDED", actor, boxId: before.id, details: { reason, target: item.id, serial: item.serial, generation: before.generation, before: { status: before.status, reportId: before.currentReportId, acceptedQty: acceptedQty + 1 }, after: { status: "RECONTROL", acceptedQty, reportId: null }, instruction: "Retirer les anciennes étiquettes de la boîte." } });
    return { boxId: after.id, acceptedQty, needsRecontrol: true };
  }, TX_OPTIONS);
}

/** Reset is a new generation of the SAME box. Optional identity editing explicitly resets all contents. */
export async function resetBoxControl(actor: Actor, input: { boxId: string; reason: string; confirmSerial: string; expectedGeneration: number; expectedAcceptedCount: number; newGalia?: string }) {
  assertAdmin(actor);
  const reason = adminReason(input.reason);
  const parsed = input.newGalia === undefined ? null : parseBoxLabel(input.newGalia);
  if (parsed?.kind === "ERROR") throw badRequest(parsed.message);
  return prisma.$transaction(async (tx) => {
    const before = await context(tx, actor, reason, input.boxId);
    if (before.boxSerial !== input.confirmSerial) throw badRequest("Saisir la série exacte de la boîte pour confirmer.");
    if (before.generation !== input.expectedGeneration) throw conflict("CONTROL_CHANGED", "La génération du contrôle a changé. Actualiser avant de réinitialiser.");
    const now = new Date();
    const items = await tx.acceptedItem.findMany({ where: { boxId: before.id, generation: before.generation, voidedAt: null }, select: { id: true, serial: true } });
    if (items.length !== input.expectedAcceptedCount) throw conflict("CONTROL_CHANGED", "La quantité a changé depuis la confirmation. Actualiser puis confirmer de nouveau.");
    await tx.acceptedItem.updateMany({ where: { id: { in: items.map((i) => i.id) }, voidedAt: null }, data: { voidedAt: now, voidedById: actor.userId, voidReason: reason } });
    await tx.controlAttempt.updateMany({ where: { boxId: before.id, generation: before.generation, voidedAt: null }, data: { voidedAt: now } });
    await tx.controlGeneration.update({ where: { boxId_number: { boxId: before.id, number: before.generation } }, data: { voidedAt: now, voidedById: actor.userId, voidReason: reason } });
    const identity = parsed?.kind === "BOX" ? { partNumber: parsed.partNumber, expectedQty: parsed.quantity, boxSerial: parsed.boxSerial, galiaPayload: parsed.payload } : { partNumber: before.partNumber, expectedQty: before.expectedQty, boxSerial: before.boxSerial, galiaPayload: before.galiaPayload };
    if (identity.boxSerial !== before.boxSerial && await tx.box.findUnique({ where: { boxSerial: identity.boxSerial } })) throw conflict("BOX_SERIAL_EXISTS", "Cette série identifie déjà une autre boîte.");
    const generation = before.generation + 1;
    await tx.controlGeneration.create({ data: { boxId: before.id, number: generation, ...identity, startedAt: now } });
    await tx.box.update({ where: { id: before.id }, data: { ...identity, generation, generationStartedAt: now, needsRecontrol: true, status: "IN_PROGRESS", currentReportId: null, activeAttemptId: null, finalizedAt: null, finalizedById: null, ownerUserId: null, ownerSessionId: null, leaseTokenHash: null, ownerSince: null } });
    await audit(tx, { type: "ADMIN_CONTROL_RESET", actor, boxId: before.id, details: { reason, target: before.id, released: items.length, before: { generation: before.generation, pn: before.partNumber, serial: before.boxSerial, expectedQty: before.expectedQty, status: before.status, reportId: before.currentReportId }, after: { generation, ...identity, acceptedQty: 0, status: "RECONTROL" }, instruction: "Retirer toutes les anciennes étiquettes : elles peuvent encore exister physiquement." } });
    return { boxId: before.id, generation, released: items.length };
  }, TX_OPTIONS);
}

export async function updateBoxNotes(actor: Actor, boxId: string, notes: string | null, reasonInput: string) {
  assertAdmin(actor);
  const reason = adminReason(reasonInput);
  if (notes && notes.length > 500) throw badRequest("Note limitée à 500 caractères.");
  return prisma.$transaction(async (tx) => {
    const before = await context(tx, actor, reason, boxId);
    const after = await tx.box.update({ where: { id: boxId }, data: { notes: notes?.trim() || null } });
    await audit(tx, { type: "ADMIN_BOX_NOTES", actor, boxId, details: { reason, target: boxId, before: { notes: before.notes }, after: { notes: after.notes } } });
    return { notes: after.notes };
  }, TX_OPTIONS);
}
