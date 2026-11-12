import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma, type Box, type Report, type ScanAttempt, type ScanOutcome } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../db";
import { audit } from "../audit";
import { randomToken, safeEqualHex, sha256Hex } from "../crypto";
import { AppError, conflict, notFound, type Actor } from "../errors";
import { boundRaw, parseBoxLabel, parseItemLabel, type ParseError } from "@/lib/barcode";
import { OUTCOME_TITLES, reportReference } from "@/lib/labels";
import { computeCounts, countsFromReport, issueCodes, issueLines, isStrictOk, piecesToRemove, type ControlCounts } from "@/lib/counting";
import { assertBoxAccess } from "../permissions";

type Tx = Prisma.TransactionClient;

/*
 * Box lifecycle
 *  - A box has one stable identity (serial, PN, quantity, GALIA payload) and
 *    one or more numbered ControlAttempts: #1 INITIAL, then CORRECTION #2, #3…
 *  - Box.activeAttemptId is the open attempt (null = closed).
 *  - Box.status is IN_PROGRESS until the first finalization, then the LATEST
 *    finalized result. A NOT OK box under correction stays NOK + open attempt.
 *  - Confirmed NOT OK recontrols start a new generation at ZERO. The previous
 *    accepted assignments are voided and released, while their records remain.
 *    Every finalized attempt has its own
 *    immutable Report; older reports are never modified.
 *  - A closed OK box is read-only. A closed NOT OK box is reopened only after
 *    the operator explicitly confirms ("OUI — Recommencer à zéro").
 *
 * Start / end (counting rules v2, see lib/counting.ts)
 *  - Scanning the GALIA opens the control. Covers are collected until the
 *    operator ENDS the control: reaching the GALIA quantity never finalizes,
 *    locks or prints anything.
 *  - Ending = rescanning the exact same GALIA payload (or « Terminer le
 *    contrôle »): one server path, finalizeBox(), that recomputes every count
 *    under the box lock and decides OK / NOT OK.
 *  - Every distinct cover is recorded: conforming covers within the quantity
 *    are reserved; excess, wrong-PN and other-box covers are observations that
 *    reserve nothing. Duplicate and invalid scans are recorded mistakes.
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
  /** 1 = legacy report (accepted quantity only), 2 = honest counting rules. */
  countingVersion: number;
  counts: ControlCounts;
  /** Concise French explanation (same lines as the label). */
  lines: string[];
  endTrigger: "GALIA_RESCAN" | "MANUAL" | null;
  reason: string | null;
  finalizedAt: string;
  finalizedBy: string;
}

/** A piece seen in a NOT OK control that must be taken out of the box. Screens only, never on the label. */
export interface PieceToRemove {
  serial: string;
  partNumber: string | null;
  reason: "EXCESS" | "WRONG_PART_NUMBER" | "OTHER_BOX_SERIAL";
}

export interface BoxSummary {
  id: string;
  generation: number;
  needsRecontrol: boolean;
  boxSerial: string;
  partNumber: string;
  expectedQty: number;
  /** Conforming covers reserved by this box's current generation. */
  acceptedCount: number;
  remaining: number;
  /** Counts of the open attempt; when closed, those of the latest report. */
  counts: ControlCounts;
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
  box: { id: string; acceptedCount: number; expectedQty: number; remaining: number; status: Box["status"]; open: boolean; counts: ControlCounts };
  createdAt: string;
  replayed: boolean;
}

export type OpenBoxResult =
  | { kind: "OPENED"; box: BoxSummary; leaseToken: string; created: boolean; tookOverFrom: string | null; correctionStarted: boolean }
  | { kind: "FINALIZED"; box: BoxSummary }
  | { kind: "CORRECTION_OFFER"; box: BoxSummary; report: ReportSummary; toRemove: PieceToRemove[] }
  | { kind: "OWNED"; box: BoxSummary; owner: { username: string; since: string | null; sameUser: boolean; sameSession: boolean } }
  | { kind: "CONFLICT"; existing: { boxSerial: string; partNumber: string; expectedQty: number }; scanned: { partNumber: string; quantity: number } }
  | { kind: "INVALID"; error: ParseError };

export type EndTrigger = "GALIA_RESCAN" | "MANUAL";

export type FinalizeResult =
  | { kind: "FINALIZED"; report: ReportSummary }
  /** Idempotent retry: this attempt was already finalized; same report. */
  | { kind: "ALREADY_FINALIZED"; report: ReportSummary }
  /** The client's view is stale (a scan it has not seen): nothing was finalized. */
  | { kind: "STATE_CHANGED"; counts: ControlCounts }
  /** The scanned GALIA is not this box's exact payload: nothing was finalized. */
  | { kind: "GALIA_MISMATCH"; scanned: { boxSerial: string; partNumber: string; quantity: number } | null };

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
  const counts = countsFromReport(r);
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
    countingVersion: r.countingVersion,
    counts,
    lines: issueLines(counts),
    endTrigger: r.endTrigger === "GALIA_RESCAN" || r.endTrigger === "MANUAL" ? r.endTrigger : null,
    reason: r.reason,
    finalizedAt: r.finalizedAt.toISOString(),
    finalizedBy: r.finalizedByUsername,
  };
}

type Db = Tx | typeof prisma;

const OBSERVATION_OUTCOMES = ["EXCESS", "QUANTITY_REACHED", "WRONG_PART_NUMBER", "DUPLICATE_OTHER_BOX"] as const satisfies readonly ScanOutcome[];

/** Counts of one attempt: reservations of the box + the attempt's recorded scans. */
async function attemptCounts(db: Db, box: { id: string; expectedQty: number }, attemptId: string | null): Promise<ControlCounts> {
  const [reserved, observations] = await Promise.all([
    db.activeSerialReservation.count({ where: { boxId: box.id } }),
    attemptId ? db.scanAttempt.findMany({ where: { controlAttemptId: attemptId }, select: { outcome: true, serial: true } }) : Promise.resolve([]),
  ]);
  return computeCounts(box.expectedQty, reserved, observations);
}

/** Distinct pieces recorded as excess / wrong PN / other box in a finalized attempt. */
async function piecesToRemoveOf(db: Db, report: Report): Promise<PieceToRemove[]> {
  if (report.countingVersion < 2 || piecesToRemove(countsFromReport(report)) === 0) return [];
  const rows = await db.scanAttempt.findMany({
    where: { controlAttemptId: report.attemptId, outcome: { in: [...OBSERVATION_OUTCOMES] } },
    orderBy: { createdAt: "asc" },
    select: { outcome: true, serial: true, partNumber: true },
  });
  const seen = new Set<string>();
  const out: PieceToRemove[] = [];
  for (const r of rows) {
    if (!r.serial || seen.has(r.serial)) continue;
    seen.add(r.serial);
    out.push({
      serial: r.serial,
      partNumber: r.partNumber,
      reason: r.outcome === "WRONG_PART_NUMBER" ? "WRONG_PART_NUMBER" : r.outcome === "DUPLICATE_OTHER_BOX" ? "OTHER_BOX_SERIAL" : "EXCESS",
    });
  }
  return out;
}

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
  const counts = a || !latest ? await attemptCounts(db, box, a?.id ?? null) : countsFromReport(latest);
  return {
    id: box.id,
    generation: box.generation,
    needsRecontrol: box.needsRecontrol,
    boxSerial: box.boxSerial,
    partNumber: box.partNumber,
    expectedQty: box.expectedQty,
    acceptedCount,
    remaining: Math.max(0, box.expectedQty - acceptedCount),
    counts,
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

/**
 * Open a complete recontrol at ZERO (caller holds the box lock). The confirmation
 * names the exact NOT OK report so an old request cannot reset a later result.
 * Pieces that were recorded as excess,
 * wrong PN or already used elsewhere are physically in the box: the operator must
 * confirm they were removed (audited) before the correction can start.
 */
async function openCorrection(tx: Tx, box: Box, actor: Actor, removalConfirmed: boolean, expectedReportId?: string): Promise<OpenBoxResult> {
  const previous = await latestReport(tx, box.id);
  if (!previous || previous.result !== "NOK") {
    throw conflict("NOT_CORRECTABLE", "Seule une boîte contrôlée NOT OK peut être corrigée.");
  }
  if (expectedReportId !== previous.id) {
    throw conflict("CORRECTION_CHANGED", "Le résultat NOT OK a changé. Rescanner la GALIA et confirmer le nouveau contrôle depuis zéro.");
  }
  const toRemove = await piecesToRemoveOf(tx, previous);
  if (toRemove.length > 0 && !removalConfirmed) {
    const n = toRemove.length;
    throw conflict(
      "REMOVAL_CONFIRMATION_REQUIRED",
      `Retirer d'abord de la boîte ${n} pièce${n > 1 ? "s" : ""} non conforme${n > 1 ? "s" : ""} ou en excédent, puis confirmer.`,
      { toRemove },
    );
  }
  const max = await tx.controlAttempt.aggregate({ where: { boxId: box.id }, _max: { number: true } });
  const number = (max._max.number ?? 0) + 1;
  const reason = "Recontrôle complet NOT OK confirmé : reprise à zéro.";
  await tx.$queryRaw`SELECT set_config('galia.nok_restart_session', ${actor.sessionId}, true),
    set_config('galia.nok_restart_box', ${box.id}, true), set_config('galia.nok_restart_report', ${previous.id}, true),
    set_config('galia.nok_restart_reason', ${reason}, true)`;
  const now = new Date();
  const released = await tx.acceptedItem.updateMany({
    where: { boxId: box.id, generation: box.generation, voidedAt: null },
    data: { voidedAt: now, voidedById: actor.userId, voidReason: reason },
  });
  await tx.controlAttempt.updateMany({ where: { boxId: box.id, generation: box.generation, voidedAt: null }, data: { voidedAt: now } });
  await tx.controlGeneration.update({ where: { boxId_number: { boxId: box.id, number: box.generation } }, data: { voidedAt: now, voidedById: actor.userId, voidReason: reason } });
  const generation = box.generation + 1;
  await tx.controlGeneration.create({ data: { boxId: box.id, number: generation, partNumber: box.partNumber, boxSerial: box.boxSerial, expectedQty: box.expectedQty, galiaPayload: box.galiaPayload, startedAt: now } });
  box = await tx.box.update({ where: { id: box.id }, data: { generation, generationStartedAt: now, status: "IN_PROGRESS", needsRecontrol: true,
    currentReportId: null, activeAttemptId: null, finalizedAt: null, finalizedById: null,
    ownerUserId: null, ownerSessionId: null, leaseTokenHash: null, ownerSince: null } });
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
      reason,
      mode: "FROM_ZERO",
      releasedSerials: released.count,
      before: { generation: generation - 1, acceptedQty: previous.acceptedQty, reportId: previous.id },
      after: { generation, acceptedQty: 0, reportId: null },
      instruction: "Retirer les anciennes étiquettes. Rescanner chaque coiffe ; les anciennes séries sont libérées et peuvent être utilisées dans une autre boîte.",
      previousIssues: previous.issues,
      removalConfirmed: toRemove.length > 0 ? true : null,
      removedPieces: toRemove.map((p) => ({ ...p })),
    },
  });
  return { kind: "OPENED", box: await loadSummary(tx, box.id), leaseToken, created: false, tookOverFrom: null, correctionStarted: true };
}

async function acquire(
  tx: Tx,
  box: Box,
  actor: Actor,
  opts: { takeover: boolean; created: boolean; startCorrection: boolean; removalConfirmed: boolean; correctionReportId?: string },
): Promise<OpenBoxResult> {
  if (box.activeAttemptId === null && box.status === "IN_PROGRESS" && !box.currentReportId) {
    const max = await tx.controlAttempt.aggregate({ where: { boxId: box.id }, _max: { number: true } });
    const attempt = await tx.controlAttempt.create({ data: { boxId: box.id, generation: box.generation, number: (max._max.number ?? 0) + 1, kind: "INITIAL", administrativeRecontrol: box.needsRecontrol, startedById: actor.userId } });
    box = await tx.box.update({ where: { id: box.id }, data: { activeAttemptId: attempt.id } });
    await audit(tx, { type: "BOX_RECONTROL_OPENED", actor, boxId: box.id, details: { generation: box.generation, attemptId: attempt.id } });
  }
  if (box.activeAttemptId === null) {
    if (box.status === "NOK") {
      if (opts.startCorrection) return openCorrection(tx, box, actor, opts.removalConfirmed, opts.correctionReportId);
      const previous = (await latestReport(tx, box.id))!;
      await audit(tx, { type: "BOX_CORRECTION_OFFERED", actor, boxId: box.id, details: { reportId: previous.id } });
      return { kind: "CORRECTION_OFFER", box: await loadSummary(tx, box.id), report: toReportSummary(previous), toRemove: await piecesToRemoveOf(tx, previous) };
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
 *   (the operator confirmed the exact offered report); nothing changes before that.
 * - A closed OK box opens read-only (FINALIZED).
 */
export async function openBox(
  actor: Actor,
  input: { raw?: string; boxId?: string; takeover?: boolean; startCorrection?: boolean; removalConfirmed?: boolean; correctionReportId?: string },
): Promise<OpenBoxResult> {
  const opts = { takeover: input.takeover === true, startCorrection: input.startCorrection === true, removalConfirmed: input.removalConfirmed === true, correctionReportId: input.correctionReportId };
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
  counts: ControlCounts,
  actorUsername: string,
  replayed: boolean,
): ScanResult {
  const detail = (attempt.detail ?? {}) as Record<string, unknown>;
  const duplicate =
    (attempt.outcome === "DUPLICATE_OTHER_BOX" || attempt.outcome === "DUPLICATE_SAME_BOX") && typeof detail.boxSerial === "string"
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
      acceptedCount: counts.reserved,
      expectedQty: box.expectedQty,
      remaining: Math.max(0, box.expectedQty - counts.reserved),
      status: box.status,
      open: box.activeAttemptId !== null,
      counts,
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
  // A retried request is never a second scan: same row, same answer, counts unchanged.
  const counts = await attemptCounts(db, attempt.box, attempt.controlAttemptId);
  return attemptToResult(attempt, attempt.box, counts, attempt.user.username, true);
}

/**
 * Record one seat-cover scan, atomically, under the box row lock.
 * Order of checks: box open, lease ownership, format, already seen in this box,
 * exact PN, serial reserved by another box, GALIA quantity reached (excess).
 * Only ACCEPTED scans create an AcceptedItem (and so reserve the serial); every
 * other answer is a recorded observation or mistake that counts in the result.
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

  const box = leaseBox;
  const count = await tx.activeSerialReservation.count({ where: { boxId: box.id } });
  const parsed = parseItemLabel(input.raw);

  let outcome: ScanOutcome;
  let errorCode: string | null = null;
  let detail: Record<string, unknown> | null = null;

  if (box.activeAttemptId === null) {
    outcome = "BOX_NOT_IN_PROGRESS";
    detail = { message: "Contrôle déjà terminé : ce scan n'est pas compté. Si une pièce a été ajoutée, rescanner la GALIA pour corriger." };
  } else if (!isLeaseHolder(box, actor, input.leaseToken)) {
    outcome = "NOT_BOX_OWNER";
    const owner = box.ownerUserId ? await tx.user.findUnique({ where: { id: box.ownerUserId }, select: { username: true } }) : null;
    detail = { message: owner ? `Boîte reprise par ${owner.username}.` : "Boîte suspendue — rescanner l'étiquette GALIA." };
  } else if (parsed.kind === "ERROR") {
    outcome = "INVALID_FORMAT";
    errorCode = parsed.code;
    detail = { message: parsed.message };
  } else {
    const reservation = await tx.activeSerialReservation.findUnique({
      where: { serial: parsed.serial },
      include: { item: { include: { box: { select: { id: true, boxSerial: true } }, acceptedBy: { select: { username: true } } } } },
    });
    const observed =
      reservation?.boxId === box.id
        ? null
        : await tx.scanAttempt.findFirst({
            where: { controlAttemptId: box.activeAttemptId, serial: parsed.serial, outcome: { in: [...OBSERVATION_OUTCOMES] } },
            orderBy: { createdAt: "asc" },
            select: { outcome: true, createdAt: true },
          });
    if (reservation?.boxId === box.id) {
      outcome = "DUPLICATE_SAME_BOX";
      detail = {
        message: "Cette coiffe est déjà comptée dans cette boîte : la quantité ne change pas.",
        boxId: box.id,
        boxSerial: box.boxSerial,
        acceptedAt: reservation.item.acceptedAt.toISOString(),
        acceptedBy: reservation.item.acceptedBy.username,
        firstOutcome: "ACCEPTED",
      };
    } else if (observed) {
      outcome = "DUPLICATE_SAME_BOX";
      detail = {
        message: `Cette pièce a déjà été scannée dans ce contrôle (${OUTCOME_TITLES[observed.outcome]}) : la quantité ne change pas.`,
        firstOutcome: observed.outcome,
        firstAt: observed.createdAt.toISOString(),
      };
    } else if (parsed.partNumber !== box.partNumber) {
      outcome = "WRONG_PART_NUMBER";
      detail = { message: `Attendu ${box.partNumber}, reçu ${parsed.partNumber}. Pièce non conforme : la retirer de la boîte.` };
    } else if (reservation) {
      // The other box keeps its reservation: nothing is transferred.
      outcome = "DUPLICATE_OTHER_BOX";
      detail = {
        message: "Série déjà utilisée dans une autre boîte : pièce non conforme pour celle-ci.",
        boxId: reservation.item.box.id,
        boxSerial: reservation.item.box.boxSerial,
        acceptedAt: reservation.item.acceptedAt.toISOString(),
        acceptedBy: reservation.item.acceptedBy.username,
      };
    } else if (count >= box.expectedQty) {
      // Recorded excess; the serial is NOT reserved (it stays free for its real box).
      outcome = "EXCESS";
      detail = { message: `Quantité GALIA déjà atteinte (${box.expectedQty}) : pièce en excédent, à retirer de la boîte.` };
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
  const counts = await attemptCounts(tx, box, box.activeAttemptId);
  return attemptToResult({ ...attempt, acceptedItem }, box, counts, actor.username, false);
}

/* -------------------------------------------------------------- finalize */

export interface FinalizeInput {
  boxId: string;
  leaseToken: string;
  /** The attempt the client is ending: a retry after success returns the same report. */
  attemptId: string;
  trigger: EndTrigger;
  /** For GALIA_RESCAN: the raw GALIA scan, which must be this box's exact payload. */
  galiaRaw?: string | null;
  /** What the operator saw (precondition only — the server recomputes everything). */
  observed: { events: number; reserved: number };
  /** Optional operator note saved on a NOT OK report. */
  note?: string | null;
}

/**
 * End the open attempt (GALIA rescan or « Terminer le contrôle » — same path).
 * Under the box lock: recomputes the counts from the committed reservations and
 * this attempt's recorded scans, decides OK / NOT OK (strict), saves one
 * immutable report and closes the attempt. A scan racing this transaction is
 * serialized by the same lock: either it is counted (and the client's stale
 * `observed` makes this call return STATE_CHANGED) or it arrives after the
 * attempt closed and is recorded as BOX_NOT_IN_PROGRESS (never silently lost).
 */
export async function finalizeBox(actor: Actor, input: FinalizeInput): Promise<FinalizeResult> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockBoxById(tx, input.boxId))) throw notFound("Boîte introuvable.");
    const box = await tx.box.findUniqueOrThrow({ where: { id: input.boxId }, include: { activeAttempt: true } });

    // Idempotent retry of an end request that already succeeded.
    if (box.activeAttemptId !== input.attemptId) {
      const done = await tx.report.findUnique({ where: { attemptId: input.attemptId } });
      if (done && done.boxId === box.id) {
        if (actor.role !== "ADMIN" && done.finalizedById !== actor.userId) throw conflict("NOT_BOX_OWNER", "Contrôle terminé par une autre session.");
        if (box.needsRecontrol || box.currentReportId !== done.id) throw conflict("CONTROL_INVALIDATED", "Ce contrôle a été remplacé ou invalidé : rescanner la GALIA.");
        return { kind: "ALREADY_FINALIZED", report: toReportSummary(done) };
      }
      if (!box.activeAttempt) {
        if (box.needsRecontrol || !box.currentReportId) throw conflict("CONTROL_INVALIDATED", "Contrôle invalidé : rescanner la GALIA pour recontrôler.");
        throw conflict("ATTEMPT_CHANGED", "Ce contrôle n'est plus ouvert : rescanner la GALIA.");
      }
      throw conflict("ATTEMPT_CHANGED", "Un autre contrôle de cette boîte est ouvert : rescanner la GALIA.");
    }
    const attempt = box.activeAttempt!;
    if (!isLeaseHolder(box, actor, input.leaseToken)) {
      throw conflict("NOT_BOX_OWNER", "Cette boîte est contrôlée par une autre session.");
    }
    if (input.trigger === "GALIA_RESCAN") {
      const parsed = parseBoxLabel(input.galiaRaw ?? "");
      if (parsed.kind !== "BOX" || parsed.payload !== box.galiaPayload) {
        return { kind: "GALIA_MISMATCH", scanned: parsed.kind === "BOX" ? { boxSerial: parsed.boxSerial, partNumber: parsed.partNumber, quantity: parsed.quantity } : null };
      }
    }

    const counts = await attemptCounts(tx, box, attempt.id);
    if (counts.events !== input.observed.events || counts.reserved !== input.observed.reserved) return { kind: "STATE_CHANGED", counts };

    const issues = issueCodes(counts);
    const result = isStrictOk(counts) ? "OK" : "NOK";
    const note = input.note?.trim() ?? "";
    const now = new Date();
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
        acceptedQty: counts.reserved,
        difference: counts.reserved - box.expectedQty,
        issues,
        countingVersion: 2,
        distinctQty: counts.distinct,
        conformingQty: counts.conforming,
        nonconformingQty: counts.nonconforming,
        wrongPartNumberQty: counts.wrongPartNumber,
        otherBoxQty: counts.otherBox,
        excessQty: counts.excess,
        extraQty: counts.extra,
        missingQty: counts.missing,
        duplicateAttempts: counts.duplicates,
        invalidAttempts: counts.invalid,
        endTrigger: input.trigger,
        reason: result === "NOK" && note ? note.slice(0, 500) : null,
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
      details: {
        reportId: report.id,
        attemptNumber: attempt.number,
        attemptKind: attempt.kind,
        result,
        trigger: input.trigger,
        expectedQty: box.expectedQty,
        acceptedQty: counts.reserved,
        counts: { ...counts },
        issues,
      },
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
      take: 20,
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
