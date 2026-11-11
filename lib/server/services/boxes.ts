import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type Box, type Report, type ScanAttempt, type ScanOutcome } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../db";
import { audit } from "../audit";
import { randomToken, safeEqualHex, sha256Hex } from "../crypto";
import { AppError, conflict, notFound, type Actor } from "../errors";
import { boundRaw, parseBoxLabel, parseItemLabel, type ParseError } from "@/lib/barcode";
import { OUTCOME_TITLES, reportReference } from "@/lib/labels";
import { assertBoxAccess } from "../permissions";

type Tx = Prisma.TransactionClient;

/*
 * Box lifecycle
 *  - A box has one stable identity (serial, PN, quantity, GALIA payload) and
 *    one or more numbered ControlAttempts: #1 INITIAL, then CORRECTION #2, #3…
 *  - Box.activeAttemptId is the open attempt (null = closed).
 *  - Box.status is IN_PROGRESS until the first finalization, then the LATEST
 *    finalized result. A NOT OK box under correction stays NOK + open attempt.
 *  - Accepted items belong to the box (cumulative across attempts) and record
 *    the attempt that accepted them. Every finalized attempt has its own
 *    immutable Report; older reports are never modified.
 *  - A closed OK box is read-only. A closed NOT OK box is reopened only after
 *    the operator explicitly confirms ("OUI — Corriger").
 */

/* ------------------------------------------------------------------ DTOs */

export interface AttemptSummary {
  id: string;
  number: number;
  kind: "INITIAL" | "CORRECTION";
  startedAt: string;
  startedBy: string;
}

export interface ReportSummary {
  id: string;
  boxId: string;
  reference: string;
  attemptNumber: number;
  kind: "INITIAL" | "CORRECTION";
  result: "OK" | "NOK";
  boxSerial: string;
  partNumber: string;
  expectedQty: number;
  acceptedQty: number;
  difference: number;
  issues: string[];
  reason: string | null;
  finalizedAt: string;
  finalizedBy: string;
}

export interface BoxSummary {
  id: string;
  generation: number;
  needsRecontrol: boolean;
  boxSerial: string;
  partNumber: string;
  expectedQty: number;
  acceptedCount: number;
  remaining: number;
  /** IN_PROGRESS before the first finalization, otherwise the latest finalized result. */
  status: Box["status"];
  galiaPayload: string;
  createdAt: string;
  createdBy: string;
  owner: { username: string; since: string | null } | null;
  /** Open attempt (initial control or correction); null when the box is closed. */
  activeAttempt: AttemptSummary | null;
  /** Latest finalized report (the one that may be printed). */
  latestReport: ReportSummary | null;
  /** During a correction: the NOT OK report the correction started from. */
  previousReport: ReportSummary | null;
  finalizedAt: string | null;
}

export interface ScanResult {
  attemptId: string;
  idempotencyKey: string;
  outcome: ScanOutcome;
  accepted: boolean;
  title: string;
  message: string | null;
  raw: string;
  partNumber: string | null;
  serial: string | null;
  expectedPartNumber: string;
  errorCode: string | null;
  duplicate: { boxId: string; boxSerial: string; acceptedAt: string; acceptedBy: string } | null;
  item: { id: string; serial: string; partNumber: string; acceptedAt: string; acceptedBy: string; attemptNumber: number } | null;
  box: { id: string; acceptedCount: number; expectedQty: number; remaining: number; status: Box["status"]; open: boolean };
  createdAt: string;
  replayed: boolean;
}

export type OpenBoxResult =
  | { kind: "OPENED"; box: BoxSummary; leaseToken: string; created: boolean; tookOverFrom: string | null; correctionStarted: boolean }
  | { kind: "FINALIZED"; box: BoxSummary }
  | { kind: "CORRECTION_OFFER"; box: BoxSummary; report: ReportSummary }
  | { kind: "OWNED"; box: BoxSummary; owner: { username: string; since: string | null; sameUser: boolean; sameSession: boolean } }
  | { kind: "CONFLICT"; existing: { boxSerial: string; partNumber: string; expectedQty: number }; scanned: { partNumber: string; quantity: number } }
  | { kind: "INVALID"; error: ParseError };

export type FinalizeResult =
  | { kind: "FINALIZED"; report: ReportSummary }
  | { kind: "ALREADY_FINALIZED"; report: ReportSummary | null }
  | { kind: "STATE_CHANGED"; acceptedCount: number }
  | { kind: "REASON_REQUIRED"; acceptedCount: number; expectedQty: number };

/* -------------------------------------------------------------- helpers */

/** Row lock on the box: serializes every mutation of one box (scan, finalize, lease, correction). */
async function lockBoxById(tx: Tx, boxId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Box" WHERE "id" = ${boxId}::uuid FOR UPDATE`;
  return rows.length === 1;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export function isLeaseHolder(box: Pick<Box, "ownerSessionId" | "leaseTokenHash">, actor: Actor, leaseToken: string): boolean {
  return box.ownerSessionId === actor.sessionId && safeEqualHex(box.leaseTokenHash, sha256Hex(leaseToken));
}

export function toReportSummary(r: Report): ReportSummary {
  return {
    id: r.id,
    boxId: r.boxId,
    reference: reportReference(r.number, r.finalizedAt),
    attemptNumber: r.attemptNumber,
    kind: r.kind,
    result: r.result === "OK" ? "OK" : "NOK",
    boxSerial: r.boxSerial,
    partNumber: r.partNumber,
    expectedQty: r.expectedQty,
    acceptedQty: r.acceptedQty,
    difference: r.difference,
    issues: r.issues,
    reason: r.reason,
    finalizedAt: r.finalizedAt.toISOString(),
    finalizedBy: r.finalizedByUsername,
  };
}

type Db = Tx | typeof prisma;

async function latestReport(db: Db, boxId: string): Promise<Report | null> {
  const box = await db.box.findUnique({ where: { id: boxId }, select: { currentReportId: true } });
  return box?.currentReportId ? db.report.findUnique({ where: { id: box.currentReportId } }) : null;
}

async function loadSummary(db: Db, boxId: string): Promise<BoxSummary> {
  const box = await db.box.findUniqueOrThrow({
    where: { id: boxId },
    include: {
      createdBy: { select: { username: true } },
      activeAttempt: { include: { startedBy: { select: { username: true } }, previousReport: true } },
      _count: { select: { reservations: true } },
    },
  });
  const [owner, latest] = await Promise.all([
    box.ownerUserId ? db.user.findUnique({ where: { id: box.ownerUserId }, select: { username: true } }) : null,
    latestReport(db, box.id),
  ]);
  const acceptedCount = box._count.reservations;
  const a = box.activeAttempt;
  return {
    id: box.id,
    generation: box.generation,
    needsRecontrol: box.needsRecontrol,
    boxSerial: box.boxSerial,
    partNumber: box.partNumber,
    expectedQty: box.expectedQty,
    acceptedCount,
    remaining: Math.max(0, box.expectedQty - acceptedCount),
    status: box.status,
    galiaPayload: box.galiaPayload,
    createdAt: box.createdAt.toISOString(),
    createdBy: box.createdBy.username,
    owner: owner ? { username: owner.username, since: box.ownerSince?.toISOString() ?? null } : null,
    activeAttempt: a ? { id: a.id, number: a.number, kind: a.kind, startedAt: a.startedAt.toISOString(), startedBy: a.startedBy.username } : null,
    latestReport: latest ? toReportSummary(latest) : null,
    previousReport: a?.previousReport ? toReportSummary(a.previousReport) : null,
    finalizedAt: box.finalizedAt?.toISOString() ?? null,
  };
}

export function getBoxSummary(boxId: string): Promise<BoxSummary> {
  return loadSummary(prisma, boxId);
}

/* ------------------------------------------------------------- open box */

async function grantLease(tx: Tx, box: Box, actor: Actor): Promise<string> {
  const leaseToken = randomToken();
  await tx.box.update({
    where: { id: box.id },
    data: { ownerUserId: actor.userId, ownerSessionId: actor.sessionId, leaseTokenHash: sha256Hex(leaseToken), ownerSince: new Date() },
  });
  return leaseToken;
}

/** Open a correction attempt on a closed NOT OK box (caller holds the box lock). */
async function openCorrection(tx: Tx, box: Box, actor: Actor): Promise<OpenBoxResult> {
  const previous = await latestReport(tx, box.id);
  if (!previous || previous.result !== "NOK") {
    throw conflict("NOT_CORRECTABLE", "Seule une boîte contrôlée NOT OK peut être corrigée.");
  }
  const max = await tx.controlAttempt.aggregate({ where: { boxId: box.id }, _max: { number: true } });
  const number = (max._max.number ?? 0) + 1;
  const attempt = await tx.controlAttempt.create({
    data: { boxId: box.id, generation: box.generation, number, kind: "CORRECTION", startedById: actor.userId, previousReportId: previous.id },
  });
  await tx.box.update({ where: { id: box.id }, data: { activeAttemptId: attempt.id } });
  const leaseToken = await grantLease(tx, { ...box, activeAttemptId: attempt.id }, actor);
  await audit(tx, {
    type: "BOX_CORRECTION_OPENED",
    actor,
    boxId: box.id,
    details: {
      attemptId: attempt.id,
      attemptNumber: number,
      previousResult: "NOK",
      previousReportId: previous.id,
      previousReference: reportReference(previous.number, previous.finalizedAt),
      previousAcceptedQty: previous.acceptedQty,
    },
  });
  return { kind: "OPENED", box: await loadSummary(tx, box.id), leaseToken, created: false, tookOverFrom: null, correctionStarted: true };
}

async function acquire(
  tx: Tx,
  box: Box,
  actor: Actor,
  opts: { takeover: boolean; created: boolean; startCorrection: boolean },
): Promise<OpenBoxResult> {
  if (box.activeAttemptId === null && box.status === "IN_PROGRESS" && !box.currentReportId) {
    const max = await tx.controlAttempt.aggregate({ where: { boxId: box.id }, _max: { number: true } });
    const attempt = await tx.controlAttempt.create({ data: { boxId: box.id, generation: box.generation, number: (max._max.number ?? 0) + 1, kind: "INITIAL", administrativeRecontrol: box.needsRecontrol, startedById: actor.userId } });
    box = await tx.box.update({ where: { id: box.id }, data: { activeAttemptId: attempt.id } });
    await audit(tx, { type: "BOX_RECONTROL_OPENED", actor, boxId: box.id, details: { generation: box.generation, attemptId: attempt.id } });
  }
  if (box.activeAttemptId === null) {
    if (box.status === "NOK") {
      if (opts.startCorrection) return openCorrection(tx, box, actor);
      const previous = await latestReport(tx, box.id);
      await audit(tx, { type: "BOX_CORRECTION_OFFERED", actor, boxId: box.id, details: { reportId: previous?.id ?? null } });
      return { kind: "CORRECTION_OFFER", box: await loadSummary(tx, box.id), report: toReportSummary(previous!) };
    }
    await audit(tx, { type: "BOX_VIEWED_FINALIZED", actor, boxId: box.id });
    return { kind: "FINALIZED", box: await loadSummary(tx, box.id) };
  }

  // An attempt is open: one controller at a time (explicit, audited handover).
  const leased = box.ownerSessionId !== null;
  if (leased && !opts.takeover) {
    const owner = box.ownerUserId ? await tx.user.findUnique({ where: { id: box.ownerUserId }, select: { username: true } }) : null;
    return {
      kind: "OWNED",
      box: await loadSummary(tx, box.id),
      owner: {
        username: owner?.username ?? "?",
        since: box.ownerSince?.toISOString() ?? null,
        sameUser: box.ownerUserId === actor.userId,
        sameSession: box.ownerSessionId === actor.sessionId,
      },
    };
  }
  let previousOwner: string | null = null;
  if (leased && box.ownerUserId) {
    previousOwner = (await tx.user.findUnique({ where: { id: box.ownerUserId }, select: { username: true } }))?.username ?? null;
  }
  const leaseToken = await grantLease(tx, box, actor);
  if (leased) {
    await audit(tx, {
      type: "BOX_TAKEOVER",
      actor,
      boxId: box.id,
      details: { fromUserId: box.ownerUserId, fromUsername: previousOwner, sameSession: box.ownerSessionId === actor.sessionId, attemptId: box.activeAttemptId },
    });
  } else if (!opts.created) {
    await audit(tx, { type: "BOX_RESUMED", actor, boxId: box.id, details: { attemptId: box.activeAttemptId } });
  }
  return { kind: "OPENED", box: await loadSummary(tx, box.id), leaseToken, created: opts.created, tookOverFrom: leased ? previousOwner : null, correctionStarted: false };
}

/**
 * Open a box from its main GALIA label (create or load) or by id.
 * - Never creates a second record for the same box serial; a serial already known
 *   with another PN or quantity is a CONFLICT and nothing is changed.
 * - A closed NOT OK box returns CORRECTION_OFFER unless `startCorrection` is true
 *   (the operator pressed "OUI — Corriger"); nothing changes before that.
 * - A closed OK box opens read-only (FINALIZED).
 */
export async function openBox(
  actor: Actor,
  input: { raw?: string; boxId?: string; takeover?: boolean; startCorrection?: boolean },
): Promise<OpenBoxResult> {
  const opts = { takeover: input.takeover === true, startCorrection: input.startCorrection === true };
  if (input.boxId) {
    const boxId = input.boxId;
    await assertBoxAccess(actor, boxId);
    return prisma.$transaction(async (tx) => {
      if (!(await lockBoxById(tx, boxId))) throw notFound("Boîte introuvable.");
      const box = await tx.box.findUniqueOrThrow({ where: { id: boxId } });
      return acquire(tx, box, actor, { ...opts, created: false });
    }, TX_OPTIONS);
  }

  const raw = input.raw ?? "";
  const parsed = parseBoxLabel(raw);
  if (parsed.kind === "ERROR") {
    await audit(prisma, { type: "BOX_LABEL_REJECTED", actor, details: { raw: boundRaw(raw), code: parsed.code } });
    return { kind: "INVALID", error: parsed };
  }

  return prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "Box" ("id", "boxSerial", "partNumber", "expectedQty", "galiaPayload", "createdById")
      VALUES (${id}::uuid, ${parsed.boxSerial}, ${parsed.partNumber}, ${parsed.quantity}, ${parsed.payload}, ${actor.userId}::uuid)
      ON CONFLICT ("boxSerial") DO NOTHING
      RETURNING "id"`;
    const created = inserted.length === 1;
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Box" WHERE "boxSerial" = ${parsed.boxSerial} FOR UPDATE`;
    let box = await tx.box.findUniqueOrThrow({ where: { id: locked[0].id } });

    if (created) {
      const attempt = await tx.controlAttempt.create({ data: { boxId: box.id, number: 1, kind: "INITIAL", startedById: actor.userId } });
      box = await tx.box.update({ where: { id: box.id }, data: { activeAttemptId: attempt.id } });
      await audit(tx, { type: "BOX_CREATED", actor, boxId: box.id, details: { raw: boundRaw(raw), attemptId: attempt.id } });
    } else if (box.partNumber !== parsed.partNumber || box.expectedQty !== parsed.quantity) {
      await audit(tx, {
        type: "BOX_CONFLICT",
        actor,
        boxId: box.id,
        details: { raw: boundRaw(raw), existingPartNumber: box.partNumber, existingQty: box.expectedQty },
      });
      return {
        kind: "CONFLICT",
        existing: { boxSerial: box.boxSerial, partNumber: box.partNumber, expectedQty: box.expectedQty },
        scanned: { partNumber: parsed.partNumber, quantity: parsed.quantity },
      };
    }
    return acquire(tx, box, actor, { ...opts, created });
  }, TX_OPTIONS);
}

/** Release this session's lease so the box can be resumed elsewhere (the attempt stays open). */
export async function suspendBox(actor: Actor, input: { boxId: string; leaseToken: string; reason?: string }): Promise<BoxSummary> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockBoxById(tx, input.boxId))) throw notFound("Boîte introuvable.");
    const box = await tx.box.findUniqueOrThrow({ where: { id: input.boxId } });
    if (box.activeAttemptId === null) throw conflict("BOX_NOT_IN_PROGRESS", "Boîte déjà finalisée.");
    if (!isLeaseHolder(box, actor, input.leaseToken)) {
      throw conflict("NOT_BOX_OWNER", "Cette boîte est contrôlée par une autre session.");
    }
    await tx.box.update({ where: { id: box.id }, data: { ownerUserId: null, ownerSessionId: null, leaseTokenHash: null, ownerSince: null } });
    await audit(tx, { type: "BOX_SUSPENDED", actor, boxId: box.id, details: { reason: input.reason ?? "manual", attemptId: box.activeAttemptId } });
    return loadSummary(tx, box.id);
  }, TX_OPTIONS);
}

/** Release every lease held by a session (logout). */
export async function releaseSessionLeases(actor: Actor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const boxes = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Box" WHERE "ownerSessionId" = ${actor.sessionId} AND "activeAttemptId" IS NOT NULL FOR UPDATE`;
    for (const { id } of boxes) {
      await tx.box.update({ where: { id }, data: { ownerUserId: null, ownerSessionId: null, leaseTokenHash: null, ownerSince: null } });
      await audit(tx, { type: "BOX_SUSPENDED", actor, boxId: id, details: { reason: "logout" } });
    }
  }, TX_OPTIONS);
}

/* ------------------------------------------------------------ item scan */

type AttemptWithItem = ScanAttempt & {
  acceptedItem: { id: string; serial: string; partNumber: string; acceptedAt: Date; voidedAt: Date | null; controlAttempt: { number: number } } | null;
};

function attemptToResult(
  attempt: AttemptWithItem,
  box: { id: string; partNumber: string; expectedQty: number; status: Box["status"]; activeAttemptId: string | null },
  acceptedCount: number,
  actorUsername: string,
  replayed: boolean,
): ScanResult {
  const detail = (attempt.detail ?? {}) as Record<string, unknown>;
  const duplicate =
    attempt.outcome === "DUPLICATE_OTHER_BOX" || attempt.outcome === "DUPLICATE_SAME_BOX"
      ? {
          boxId: String(detail.boxId ?? ""),
          boxSerial: String(detail.boxSerial ?? ""),
          acceptedAt: String(detail.acceptedAt ?? ""),
          acceptedBy: String(detail.acceptedBy ?? ""),
        }
      : null;
  return {
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyKey,
    outcome: attempt.outcome,
    accepted: attempt.outcome === "ACCEPTED",
    title: OUTCOME_TITLES[attempt.outcome],
    message: typeof detail.message === "string" ? detail.message : null,
    raw: attempt.rawPayload,
    partNumber: attempt.partNumber,
    serial: attempt.serial,
    expectedPartNumber: box.partNumber,
    errorCode: attempt.errorCode,
    duplicate,
    item: attempt.acceptedItem
      ? {
          id: attempt.acceptedItem.id,
          serial: attempt.acceptedItem.serial,
          partNumber: attempt.acceptedItem.partNumber,
          acceptedAt: attempt.acceptedItem.acceptedAt.toISOString(),
          acceptedBy: actorUsername,
          attemptNumber: attempt.acceptedItem.controlAttempt.number,
        }
      : null,
    box: {
      id: box.id,
      acceptedCount,
      expectedQty: box.expectedQty,
      remaining: Math.max(0, box.expectedQty - acceptedCount),
      status: box.status,
      open: box.activeAttemptId !== null,
    },
    createdAt: attempt.createdAt.toISOString(),
    replayed,
  };
}

const ITEM_SELECT = { id: true, serial: true, partNumber: true, acceptedAt: true, voidedAt: true, controlAttempt: { select: { number: true } } } as const;

async function replayIfKnown(db: Db, actor: Actor, idempotencyKey: string, requestHash: string): Promise<ScanResult | null> {
  const attempt = await db.scanAttempt.findUnique({
    where: { idempotencyKey },
    include: {
      acceptedItem: { select: ITEM_SELECT },
      box: { select: { id: true, partNumber: true, expectedQty: true, status: true, activeAttemptId: true, generation: true, needsRecontrol: true } },
      user: { select: { username: true } },
    },
  });
  if (!attempt) return null;
  if (attempt.requestHash !== requestHash || attempt.userId !== actor.userId) {
    throw conflict("IDEMPOTENCY_KEY_REUSED", "Clé de requête déjà utilisée pour un autre scan.");
  }
  if (attempt.generation !== attempt.box.generation || attempt.acceptedItem?.voidedAt || (attempt.box.needsRecontrol && !attempt.box.activeAttemptId)) {
    throw conflict("CONTROL_INVALIDATED", "Ce scan appartient à un contrôle annulé. Rescanner la GALIA pour recontrôler.");
  }
  const count = await db.activeSerialReservation.count({ where: { boxId: attempt.boxId } });
  return attemptToResult(attempt, attempt.box, count, attempt.user.username, true);
}

/**
 * Validate and (if every rule passes) accept one seat-cover scan, atomically.
 * Order of checks under the box row lock: box open, lease ownership, format,
 * exact PN equality, global serial uniqueness, remaining (cumulative) quantity.
 * Only ACCEPTED scans create an AcceptedItem (and so reserve the serial).
 */
export async function scanItem(
  actor: Actor,
  input: { boxId: string; leaseToken: string; raw: string; idempotencyKey: string },
): Promise<ScanResult> {
  const requestHash = sha256Hex(`${input.boxId}\n${input.raw}`);

  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction((tx) => scanInTransaction(tx, actor, input, requestHash), TX_OPTIONS);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Either the same key committed concurrently (replay it) or the same serial
      // was accepted concurrently in another box (re-run: it is now a duplicate).
      if (attempt >= 3) throw e;
    }
  }
}

async function scanInTransaction(
  tx: Tx,
  actor: Actor,
  input: { boxId: string; leaseToken: string; raw: string; idempotencyKey: string },
  requestHash: string,
): Promise<ScanResult> {
  if (!(await lockBoxById(tx, input.boxId))) throw notFound("Boîte introuvable.");
  const leaseBox = await tx.box.findUniqueOrThrow({ where: { id: input.boxId } });
  const replay = await replayIfKnown(tx, actor, input.idempotencyKey, requestHash);
  if (replay) {
    if (leaseBox.activeAttemptId && !isLeaseHolder(leaseBox, actor, input.leaseToken)) throw conflict("NOT_BOX_OWNER", "Ancien bail révoqué : rescanner la GALIA.");
    return replay;
  }

  const box = await tx.box.findUniqueOrThrow({ where: { id: input.boxId } });
  const count = await tx.activeSerialReservation.count({ where: { boxId: box.id } });
  const parsed = parseItemLabel(input.raw);

  let outcome: ScanOutcome;
  let errorCode: string | null = null;
  let detail: Record<string, unknown> | null = null;

  if (box.activeAttemptId === null) {
    outcome = "BOX_NOT_IN_PROGRESS";
  } else if (!isLeaseHolder(box, actor, input.leaseToken)) {
    outcome = "NOT_BOX_OWNER";
    const owner = box.ownerUserId ? await tx.user.findUnique({ where: { id: box.ownerUserId }, select: { username: true } }) : null;
    detail = { message: owner ? `Boîte reprise par ${owner.username}.` : "Boîte suspendue — rescanner l'étiquette GALIA." };
  } else if (parsed.kind === "ERROR") {
    outcome = "INVALID_FORMAT";
    errorCode = parsed.code;
    detail = { message: parsed.message };
  } else if (parsed.partNumber !== box.partNumber) {
    outcome = "WRONG_PART_NUMBER";
    detail = { message: `Attendu ${box.partNumber}, reçu ${parsed.partNumber}.` };
  } else {
    const existing = await tx.acceptedItem.findFirst({
      where: { serial: parsed.serial, voidedAt: null, reservation: { isNot: null } },
      include: { box: { select: { id: true, boxSerial: true } }, acceptedBy: { select: { username: true } } },
    });
    if (existing) {
      outcome = existing.boxId === box.id ? "DUPLICATE_SAME_BOX" : "DUPLICATE_OTHER_BOX";
      detail = {
        boxId: existing.box.id,
        boxSerial: existing.box.boxSerial,
        acceptedAt: existing.acceptedAt.toISOString(),
        acceptedBy: existing.acceptedBy.username,
      };
    } else if (count >= box.expectedQty) {
      outcome = "QUANTITY_REACHED";
    } else {
      outcome = "ACCEPTED";
    }
  }

  const parsedOk = parsed.kind === "ITEM" ? parsed : null;
  const attempt = await tx.scanAttempt.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      requestHash,
      boxId: box.id,
      generation: box.generation,
      controlAttemptId: box.activeAttemptId,
      userId: actor.userId,
      sessionId: actor.sessionId,
      rawPayload: boundRaw(input.raw),
      rawLength: input.raw.length,
      partNumber: parsedOk?.partNumber ?? null,
      serial: parsedOk?.serial ?? null,
      outcome,
      errorCode,
      detail: detail === null ? undefined : (detail as Prisma.InputJsonValue),
    },
  });

  let acceptedItem: AttemptWithItem["acceptedItem"] = null;
  if (outcome === "ACCEPTED" && parsedOk && box.activeAttemptId) {
    acceptedItem = await tx.acceptedItem.create({
      data: {
        serial: parsedOk.serial,
        partNumber: parsedOk.partNumber,
        rawPayload: parsedOk.payload,
        boxId: box.id,
        generation: box.generation,
        controlAttemptId: box.activeAttemptId,
        acceptedById: actor.userId,
        attemptId: attempt.id,
      },
      select: ITEM_SELECT,
    });
  }
  const acceptedCount = count + (acceptedItem ? 1 : 0);
  return attemptToResult({ ...attempt, acceptedItem }, box, acceptedCount, actor.username, false);
}

/* -------------------------------------------------------------- finalize */

export const FINALIZE_REASON_MIN = 3;

/**
 * Finalize the open attempt. The result is recomputed from ALL committed items
 * of the box (cumulative across attempts) under the box lock — never taken from
 * the client. `observedAcceptedCount` is only a precondition. A new immutable
 * report is created for this attempt; earlier reports are left untouched.
 */
export async function finalizeBox(
  actor: Actor,
  input: { boxId: string; leaseToken: string; observedAcceptedCount: number; incompleteReason?: string | null },
): Promise<FinalizeResult> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockBoxById(tx, input.boxId))) throw notFound("Boîte introuvable.");
    const box = await tx.box.findUniqueOrThrow({ where: { id: input.boxId }, include: { activeAttempt: true } });
    if (!box.activeAttempt) {
      if (box.needsRecontrol || !box.currentReportId) throw conflict("CONTROL_INVALIDATED", "Contrôle invalidé : rescanner la GALIA pour recontrôler.");
      const latest = await latestReport(tx, box.id);
      return { kind: "ALREADY_FINALIZED", report: latest ? toReportSummary(latest) : null };
    }
    if (!isLeaseHolder(box, actor, input.leaseToken)) {
      throw conflict("NOT_BOX_OWNER", "Cette boîte est contrôlée par une autre session.");
    }
    const items = await tx.acceptedItem.findMany({ where: { boxId: box.id, voidedAt: null, generation: box.generation }, select: { serial: true, partNumber: true } });
    const acceptedQty = items.length;
    if (acceptedQty !== input.observedAcceptedCount) return { kind: "STATE_CHANGED", acceptedCount: acceptedQty };

    const issues: string[] = [];
    if (acceptedQty < box.expectedQty) issues.push("INCOMPLETE");
    if (acceptedQty > box.expectedQty) issues.push("OVER_QUANTITY");
    if (items.some((i) => i.partNumber !== box.partNumber)) issues.push("PART_NUMBER_MISMATCH");
    if (new Set(items.map((i) => i.serial)).size !== acceptedQty) issues.push("DUPLICATE_SERIAL");

    const reason = input.incompleteReason?.trim() ?? "";
    if (issues.includes("INCOMPLETE") && reason.length < FINALIZE_REASON_MIN) {
      return { kind: "REASON_REQUIRED", acceptedCount: acceptedQty, expectedQty: box.expectedQty };
    }
    const result = issues.length === 0 ? "OK" : "NOK";
    const now = new Date();
    const attempt = box.activeAttempt;
    const report = await tx.report.create({
      data: {
        boxId: box.id,
        attemptId: attempt.id,
        attemptNumber: attempt.number,
        kind: attempt.kind,
        result,
        boxSerial: box.boxSerial,
        partNumber: box.partNumber,
        galiaPayload: box.galiaPayload,
        expectedQty: box.expectedQty,
        acceptedQty,
        difference: acceptedQty - box.expectedQty,
        issues,
        reason: result === "NOK" && reason ? reason.slice(0, 500) : null,
        finalizedById: actor.userId,
        finalizedByUsername: actor.username,
        finalizedAt: now,
      },
    });
    await tx.controlAttempt.update({ where: { id: attempt.id }, data: { status: "FINALIZED", finalizedAt: now } });
    await tx.box.update({
      where: { id: box.id },
      data: {
        status: result,
        currentReportId: report.id,
        needsRecontrol: false,
        activeAttemptId: null,
        finalizedAt: now,
        finalizedById: actor.userId,
        ownerUserId: null,
        ownerSessionId: null,
        leaseTokenHash: null,
        ownerSince: null,
      },
    });
    await audit(tx, {
      type: "BOX_FINALIZED",
      actor,
      boxId: box.id,
      details: { reportId: report.id, attemptNumber: attempt.number, attemptKind: attempt.kind, result, acceptedQty, expectedQty: box.expectedQty, issues },
    });
    return { kind: "FINALIZED", report: toReportSummary(report) };
  }, TX_OPTIONS);
}

/* ------------------------------------------------------------ read side */

export interface BoxWorkState {
  box: BoxSummary;
  items: { id: string; serial: string; partNumber: string; acceptedAt: string; acceptedBy: string; attemptNumber: number }[];
  rejections: { id: string; outcome: ScanOutcome; title: string; raw: string; createdAt: string; username: string; message: string | null }[];
}

/** Live state for the control page (authoritative counts from the database). */
export async function getBoxWorkState(boxId: string): Promise<BoxWorkState> {
  const box = await loadSummary(prisma, boxId).catch(() => {
    throw notFound("Boîte introuvable.");
  });
  const [items, rejections] = await Promise.all([
    prisma.acceptedItem.findMany({
      where: { boxId, voidedAt: null, generation: box.generation },
      orderBy: { acceptedAt: "desc" },
      include: { acceptedBy: { select: { username: true } }, controlAttempt: { select: { number: true } } },
    }),
    prisma.scanAttempt.findMany({
      // During an attempt, show the rejections of that attempt only.
      where: { boxId, outcome: { not: "ACCEPTED" }, ...(box.activeAttempt ? { controlAttemptId: box.activeAttempt.id } : {}) },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { user: { select: { username: true } } },
    }),
  ]);
  return {
    box,
    items: items.map((i) => ({
      id: i.id,
      serial: i.serial,
      partNumber: i.partNumber,
      acceptedAt: i.acceptedAt.toISOString(),
      acceptedBy: i.acceptedBy.username,
      attemptNumber: i.controlAttempt.number,
    })),
    rejections: rejections.map((r) => ({
      id: r.id,
      outcome: r.outcome,
      title: OUTCOME_TITLES[r.outcome],
      raw: r.rawPayload,
      createdAt: r.createdAt.toISOString(),
      username: r.user.username,
      message: typeof (r.detail as Record<string, unknown> | null)?.message === "string" ? String((r.detail as Record<string, unknown>).message) : null,
    })),
  };
}

/** Boxes with an open attempt (initial control or correction), newest first. */
export async function listInProgressBoxes(limit = 15, actor?: Actor): Promise<BoxSummary[]> {
  const boxes = await prisma.box.findMany({
    where: { activeAttemptId: { not: null }, ...(actor?.role === "OPERATOR" ? { OR: [{ ownerUserId: actor.userId }, { createdById: actor.userId }, { controlAttempts: { some: { startedById: actor.userId } } }] } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true },
  });
  return Promise.all(boxes.map((b) => loadSummary(prisma, b.id)));
}

export { AppError };
