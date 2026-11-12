import "server-only";
import type { Prisma, PrintJob, PrinterProfile, PrintJobType } from "@prisma/client";
import { qrMatrix } from "../qr";
import { prisma, TX_OPTIONS } from "../db";
import { audit } from "../audit";
import { nameUuid, sha256Hex } from "../crypto";
import { AppError, badRequest, conflict, notFound, type Actor } from "../errors";
import { sanitizeDisplayText } from "@/lib/zpl/encode";
import { LabelLayoutError, TEMPLATE_VERSION, labelFrame, validateConfig, worstCaseContents, type LabelConfig, type LabelContent, type Orientation, type ContentPosition } from "@/lib/zpl/layout";
export { worstCaseContents };
import { renderLabel, renderSvg } from "@/lib/zpl/render";
import { reportReference } from "@/lib/labels";
import { countsFromReport, issueLines, isStrictOk } from "@/lib/counting";
import { formatDateTime } from "@/lib/time";
import { assertReportAccess } from "../permissions";

/*
 * Printing = browser print dialog (window.print) + the Windows ZD421 driver of the
 * operator's PC. The server renders the label from one immutable report, stores
 * the exact SVG snapshot in a print job and serves it on /etiquette/<job>. The
 * operator chooses the printer in the dialog. The job status DIALOG_REQUESTED is
 * final: the software never knows whether a label physically came out.
 *
 * Geometry: widthMm = label width across the printhead, heightMm = length along
 * the feed. LANDSCAPE (legacy): the page is heightMm × widthMm landscape and the
 * Windows driver turns it once onto the roll. ROTATE_90: portrait page, content
 * turned once inside the SVG (default, page matches the roll). NONE: portrait page and content.
 */

/** Layout units per millimetre (geometry only; the physical size is set in mm). */
const LABEL_UNITS_DPI = 203 as const;

export interface PrintJobDto {
  id: string;
  type: PrintJobType;
  status: PrintJob["status"];
  method: string;
  reportId: string | null;
  originalJobId: string | null;
  requestedBy: string;
  workstationName: string | null;
  widthMm: number;
  heightMm: number;
  orientation: Orientation | null;
  templateVersion: string;
  payloadSha256: string;
  reprintReason: string | null;
  createdAt: string;
  errorMessage: string | null;
}

export function toJobDto(j: PrintJob): PrintJobDto {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    method: j.method,
    reportId: j.reportId,
    originalJobId: j.originalJobId,
    requestedBy: j.requestedByUsername,
    workstationName: j.workstationName,
    widthMm: j.widthMm,
    heightMm: j.heightMm,
    orientation: j.orientation === "LANDSCAPE" || j.orientation === "ROTATE_90" || j.orientation === "NONE" ? j.orientation : null,
    templateVersion: j.templateVersion,
    payloadSha256: j.payloadSha256,
    reprintReason: j.reprintReason,
    createdAt: j.createdAt.toISOString(),
    errorMessage: j.errorMessage,
  };
}

/* ------------------------------------------- workstation label settings */

export interface PrinterProfileDto {
  workstationId: string;
  name: string;
  /** Across the printhead. */
  widthMm: number;
  printableWidthMm: number | null;
  /** Along the feed. */
  heightMm: number;
  orientation: Orientation;
  contentPosition: ContentPosition;
  contentLengthMm: number | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  updatedAt: string;
}

function toOrientation(value: string | null | undefined): Orientation {
  return value === "NONE" || value === "LANDSCAPE" ? value : "ROTATE_90";
}

async function toProfileDto(p: PrinterProfile): Promise<PrinterProfileDto> {
  const confirmer = p.confirmedById ? await prisma.user.findUnique({ where: { id: p.confirmedById }, select: { username: true } }) : null;
  return {
    workstationId: p.workstationId,
    name: p.name,
    widthMm: p.widthMm,
    printableWidthMm: p.printableWidthMm,
    heightMm: p.heightMm,
    orientation: toOrientation(p.orientation),
    contentPosition: p.contentPosition as ContentPosition,
    contentLengthMm: p.contentLengthMm,
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    confirmedBy: confirmer?.username ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function getPrinterProfile(workstationId: string): Promise<PrinterProfileDto | null> {
  const p = await prisma.printerProfile.findUnique({ where: { workstationId } });
  return p ? toProfileDto(p) : null;
}

export interface ProfileInput {
  workstationId: string;
  name: string;
  widthMm: number;
  printableWidthMm?: number | null;
  heightMm: number;
  orientation?: Orientation;
  contentPosition?: ContentPosition;
  contentLengthMm?: number | null;
}

/** Save this workstation's label settings. A size or orientation change clears the confirmation. */
export async function savePrinterProfile(actor: Actor, input: ProfileInput): Promise<PrinterProfileDto> {
  const before = await prisma.printerProfile.findUnique({ where: { workstationId: input.workstationId } });
  const orientation = input.orientation ?? toOrientation(before?.orientation);
  const contentPosition = input.contentPosition ?? (before?.contentPosition as ContentPosition | undefined) ?? "CENTER";
  const contentLengthMm = input.contentLengthMm === undefined ? before?.contentLengthMm ?? null : input.contentLengthMm;
  const printableWidthMm = input.printableWidthMm === undefined ? before ? before.printableWidthMm : 104 : input.printableWidthMm;
  try { validateConfig({ widthMm: input.widthMm, printableWidthMm, heightMm: input.heightMm, orientation, contentPosition, contentLengthMm, dpi: LABEL_UNITS_DPI, accentMode: "UTF8" }); } catch (e) { layoutErrorToApp(e); }
  const changed = !before || before.widthMm !== input.widthMm || before.printableWidthMm !== printableWidthMm || before.heightMm !== input.heightMm || toOrientation(before.orientation) !== orientation || before.contentPosition !== contentPosition || before.contentLengthMm !== contentLengthMm;
  const data = {
    name: input.name,
    widthMm: input.widthMm,
    printableWidthMm,
    heightMm: input.heightMm,
    orientation,
    contentPosition,
    contentLengthMm,
    accentMode: "UTF8",
    updatedById: actor.userId,
    ...(changed ? { confirmedAt: null, confirmedById: null } : {}),
  };
  const saved = await prisma.printerProfile.upsert({
    where: { workstationId: input.workstationId },
    create: { workstationId: input.workstationId, ...data },
    update: data,
  });
  await audit(prisma, {
    type: "LABEL_SETTINGS_SAVED",
    actor,
    details: { workstationId: input.workstationId, name: input.name, widthMm: input.widthMm, printableWidthMm, heightMm: input.heightMm, orientation, contentPosition, contentLengthMm, confirmationCleared: changed },
  });
  return toProfileDto(saved);
}

function labelConfig(p: Pick<PrinterProfile, "widthMm" | "heightMm" | "orientation" | "contentPosition" | "contentLengthMm" | "printableWidthMm">): LabelConfig {
  return { widthMm: p.widthMm, printableWidthMm: p.printableWidthMm, heightMm: p.heightMm, dpi: LABEL_UNITS_DPI, accentMode: "UTF8", orientation: toOrientation(p.orientation), contentPosition: p.contentPosition as ContentPosition, contentLengthMm: p.contentLengthMm };
}

function layoutErrorToApp(e: unknown): never {
  if (e instanceof LabelLayoutError) throw new AppError(422, "LABEL_LAYOUT", e.message);
  throw e;
}

/** Explicit confirmation (after a TEST label printed at 100 %) of this workstation's label size. */
export async function confirmPrinterProfile(actor: Actor, input: { workstationId: string; labelChecked: boolean }): Promise<PrinterProfileDto> {
  if (!input.labelChecked) throw badRequest("Cocher la vérification de l'étiquette TEST.");
  const p = await prisma.printerProfile.findUnique({ where: { workstationId: input.workstationId } });
  if (!p) throw notFound("Aucun réglage d'étiquette pour ce poste.");
  try {
    for (const content of worstCaseContents()) renderLabel(content, labelConfig(p));
  } catch (e) {
    layoutErrorToApp(e);
  }
  const saved = await prisma.printerProfile.update({ where: { workstationId: p.workstationId }, data: { confirmedAt: new Date(), confirmedById: actor.userId } });
  await audit(prisma, { type: "LABEL_SETTINGS_CONFIRMED", actor, details: { workstationId: p.workstationId, name: p.name, widthMm: p.widthMm, printableWidthMm: p.printableWidthMm, heightMm: p.heightMm, orientation: toOrientation(p.orientation), contentPosition: p.contentPosition, contentLengthMm: p.contentLengthMm, templateVersion: TEMPLATE_VERSION } });
  return toProfileDto(saved);
}

/* ----------------------------------------------------------- label data */

type ReportForLabel = {
  result: "IN_PROGRESS" | "OK" | "NOK";
  finalizedByUsername: string;
  finalizedAt: Date;
  partNumber: string;
  boxSerial: string;
  galiaPayload: string;
  expectedQty: number;
  acceptedQty: number;
  difference: number;
  issues: string[];
  countingVersion: number;
  excessQty: number;
  wrongPartNumberQty: number;
  otherBoxQty: number;
  duplicateAttempts: number;
  invalidAttempts: number;
};

/**
 * Label content from ONE saved, immutable report: every number and line comes
 * from the report snapshot. OK labels exist only when the saved result is OK AND
 * the saved counts are strictly OK; the QR then holds the exact GALIA payload.
 */
export function labelContentFromReport(report: ReportForLabel, reprint: boolean): LabelContent {
  const counts = countsFromReport(report);
  const figures = { expected: counts.expected, distinct: counts.distinct, conforming: counts.conforming, nonconforming: counts.nonconforming, lines: issueLines(counts) };
  const base = { operator: report.finalizedByUsername, partNumber: report.partNumber, boxSerial: report.boxSerial, figures, finalizedAt: formatDateTime(report.finalizedAt), reprint };
  if (report.result === "OK") {
    if (!isStrictOk(counts) || report.issues.length > 0) {
      throw new AppError(500, "REPORT_INCONSISTENT", "Rapport incohérent : impression refusée.");
    }
    return { template: "OK", ...base, galiaPayload: report.galiaPayload };
  }
  if (report.result === "NOK") return { template: "NOT_OK", ...base };
  throw conflict("BOX_NOT_FINALIZED", "Boîte non finalisée : aucune étiquette possible.");
}

/** Physical-size SVG of a label (real QR on OK labels). */
function renderPhysicalSvg(content: LabelContent, cfg: LabelConfig): string {
  try {
    const frame = labelFrame(cfg);
    return renderLabel(content, cfg, { qrMatrix, physical: { widthMm: frame.pageWidthMm, heightMm: frame.pageHeightMm } }).svg;
  } catch (e) {
    layoutErrorToApp(e);
  }
}

/** On-screen preview of a report label for this workstation's label size (reading orientation). */
export async function previewReportLabel(reportId: string, workstationId: string): Promise<{ svg: string; warning: string | null }> {
  const [report, profile] = await Promise.all([
    prisma.report.findUnique({ where: { id: reportId } }),
    prisma.printerProfile.findUnique({ where: { workstationId } }),
  ]);
  if (!report) throw notFound("Rapport introuvable.");
  if (!profile) throw notFound("Aucun réglage d'étiquette pour ce poste.");
  try {
    const { layout } = renderLabel(labelContentFromReport(report, false), labelConfig(profile));
    return { svg: renderSvg(layout, { qrMatrix }), warning: profile.confirmedAt ? null : "Taille d'étiquette non confirmée." };
  } catch (e) {
    layoutErrorToApp(e);
  }
}

/**
 * On-screen previews of the TEST label: `svg` in reading orientation, `pageSvg`
 * as it lies on the stock coming out of the printer (rotated when ROTATE_90).
 */
export async function previewTestLabel(actor: Actor, workstationId: string): Promise<{ svg: string; pageSvg: string; fitScale: number }> {
  const profile = await prisma.printerProfile.findUnique({ where: { workstationId } });
  if (!profile) throw notFound("Aucun réglage d'étiquette pour ce poste.");
  try {
    const { layout } = renderLabel({ template: "TEST", operator: actor.username, workstationName: sanitizeDisplayText(profile.name) }, labelConfig(profile));
    return { svg: renderSvg(layout, { qrMatrix }), pageSvg: renderSvg(layout, { qrMatrix, page: true }), fitScale: layout.fitScale };
  } catch (e) {
    layoutErrorToApp(e);
  }
}

/**
 * A production label may only be printed for the LATEST report of a box, and
 * never while a correction of that box is open. Locks: the report row
 * (FOR NO KEY UPDATE: serializes print requests without blocking the foreign-key
 * check of a correction that references it) then the box row (FOR SHARE: waits
 * for an in-flight finalization/correction opening).
 */
export async function assertPrintableReport(tx: Prisma.TransactionClient, reportId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Report" WHERE "id" = ${reportId}::uuid FOR NO KEY UPDATE`;
  if (locked.length !== 1) throw notFound("Rapport introuvable.");
  const report = await tx.report.findUniqueOrThrow({ where: { id: reportId } });
  await tx.$queryRaw`SELECT "id" FROM "Box" WHERE "id" = ${report.boxId}::uuid FOR SHARE`;
  const box = await tx.box.findUniqueOrThrow({ where: { id: report.boxId }, select: { activeAttemptId: true, currentReportId: true, needsRecontrol: true } });
  if (box.needsRecontrol || !box.currentReportId) throw conflict("CONTROL_INVALIDATED", "Contrôle invalidé — À recontrôler. Retirer les anciennes étiquettes de la boîte.");
  if (box.activeAttemptId) {
    throw conflict("CORRECTION_IN_PROGRESS", "Correction en cours sur cette boîte : impression bloquée jusqu'à la finalisation de la correction.");
  }
  if (box.currentReportId !== report.id) throw conflict("REPORT_SUPERSEDED", "Rapport remplacé ou contrôle réinitialisé : impression interdite.");
  const latest = await tx.report.findFirst({
    where: { boxId: report.boxId },
    orderBy: [{ finalizedAt: "desc" }, { number: "desc" }],
    select: { id: true, number: true, finalizedAt: true },
  });
  if (latest && latest.id !== report.id) {
    throw conflict("REPORT_SUPERSEDED", `Rapport remplacé par ${reportReference(latest.number, latest.finalizedAt)} : seul le rapport le plus récent peut être imprimé.`);
  }
  return report;
}

/* ------------------------------------------------------------ print jobs */

export interface CreatePrintJobInput {
  idempotencyKey: string;
  kind: PrintJobType;
  reportId: string | null;
  workstationId: string;
  reprintReason: string | null;
}

/**
 * Record one print request and its immutable label snapshot (status
 * DIALOG_REQUESTED). The browser then opens its print dialog on /etiquette/<job>.
 * Idempotent on `idempotencyKey` (double click / network retry = same job).
 * The first label of a report is ORIGINAL; any later one is an explicit,
 * reasoned REPRINT marked « RÉIMPRESSION » (a cancelled dialog cannot be detected).
 */
export async function createPrintJob(actor: Actor, input: CreatePrintJobInput): Promise<{ job: PrintJobDto; replayed: boolean }> {
  if (input.reportId) await assertReportAccess(actor, input.reportId);
  const requestHash = sha256Hex(JSON.stringify([input.kind, input.reportId ?? null, input.workstationId, input.reprintReason ?? null]));
  const existing = await prisma.printJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.requestHash !== requestHash || existing.requestedById !== actor.userId) {
      throw conflict("IDEMPOTENCY_KEY_REUSED", "Clé d'impression déjà utilisée pour une autre demande.");
    }
    if (input.reportId) await prisma.$transaction((tx) => assertPrintableReport(tx, input.reportId!), TX_OPTIONS);
    return { job: toJobDto(existing), replayed: true };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const profile = await tx.printerProfile.findUnique({ where: { workstationId: input.workstationId } });
      if (!profile) throw conflict("LABEL_NOT_CONFIGURED", "Régler d'abord la taille d'étiquette de ce poste (page Étiquette).");
      if (input.kind !== "TEST" && !profile.confirmedAt) {
        throw conflict("LABEL_NOT_CONFIRMED", "Imprimer d'abord une étiquette TEST et confirmer la taille d'étiquette de ce poste (page Étiquette).");
      }
      const cfg = labelConfig(profile);

      let content: LabelContent;
      let originalJobId: string | null = null;
      if (input.kind === "TEST") {
        content = { template: "TEST", operator: actor.username, workstationName: sanitizeDisplayText(profile.name) };
      } else {
        if (!input.reportId) throw badRequest("Rapport manquant.");
        const report = await assertPrintableReport(tx, input.reportId);
        const previous = await tx.printJob.findMany({
          where: { reportId: report.id, type: "ORIGINAL", status: { not: "FAILED" } },
          orderBy: { createdAt: "asc" },
        });
        const firstOriginal = previous[0] ?? null;
        if (input.kind === "ORIGINAL" && firstOriginal) {
          throw conflict("ALREADY_PRINTED", "Une étiquette a déjà été demandée pour ce rapport : utiliser « Réimprimer… ».", { jobId: firstOriginal.id });
        }
        if (input.kind === "REPRINT") {
          if (!firstOriginal) throw conflict("NO_ORIGINAL_PRINT", "Aucune impression demandée : utiliser « Imprimer l'étiquette ».");
          if (!input.reprintReason || input.reprintReason.trim().length < 3) throw badRequest("Motif de réimpression obligatoire.");
          originalJobId = firstOriginal.id;
        }
        content = labelContentFromReport(report, input.kind === "REPRINT");
      }

      const svg = renderPhysicalSvg(content, cfg);
      const job = await tx.printJob.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          requestHash,
          type: input.kind,
          status: "DIALOG_REQUESTED",
          method: "PRINT_DIALOG",
          reportId: input.kind === "TEST" ? null : input.reportId,
          originalJobId,
          requestedById: actor.userId,
          requestedByUsername: actor.username,
          sessionId: actor.sessionId,
          workstationId: profile.workstationId,
          workstationName: profile.name,
          printerName: null,
          printerUid: null,
          dpi: null,
          // The printed PAGE (LANDSCAPE: length × width); the stock is in the workstation profile.
          widthMm: labelFrame(cfg).pageWidthMm,
          heightMm: labelFrame(cfg).pageHeightMm,
          orientation: labelFrame(cfg).orientation,
          accentMode: cfg.accentMode,
          templateVersion: TEMPLATE_VERSION,
          reprintReason: input.kind === "REPRINT" ? input.reprintReason!.trim().slice(0, 200) : null,
          payload: svg,
          payloadSha256: sha256Hex(svg),
        },
      });
      const report = job.reportId ? await tx.report.findUnique({ where: { id: job.reportId }, select: { boxId: true } }) : null;
      await audit(tx, {
        type: "PRINT_DIALOG_REQUESTED",
        actor,
        boxId: report?.boxId ?? null,
        details: { jobId: job.id, type: job.type, reportId: job.reportId, workstation: job.workstationName, reprintReason: job.reprintReason },
      });
      return { job: toJobDto(job), replayed: false };
    }, TX_OPTIONS);
  } catch (e) {
    // Concurrent creation with the same key: return the committed job.
    const raced = await prisma.printJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (raced && raced.requestHash === requestHash && raced.requestedById === actor.userId) {
      if (input.reportId) await prisma.$transaction((tx) => assertPrintableReport(tx, input.reportId!), TX_OPTIONS);
      return { job: toJobDto(raced), replayed: true };
    }
    throw e;
  }
}

export type AutoPrint =
  | { status: "REQUESTED"; job: PrintJobDto; replayed: boolean }
  | { status: "BLOCKED"; code: string; message: string };

/**
 * The automatic print request made when a control ends: one ORIGINAL job per
 * report, keyed by the report id, so a retried or repeated end request returns
 * the same job (never a second label). Failures never touch the finalized report.
 */
export async function requestAutomaticPrint(actor: Actor, reportId: string, workstationId: string | null | undefined): Promise<AutoPrint> {
  if (!workstationId) return { status: "BLOCKED", code: "NO_WORKSTATION", message: "Poste non identifié (stockage du navigateur indisponible) : étiquette non préparée." };
  try {
    const { job, replayed } = await createPrintJob(actor, { idempotencyKey: nameUuid(`auto-print:${reportId}`), kind: "ORIGINAL", reportId, workstationId, reprintReason: null });
    return { status: "REQUESTED", job, replayed };
  } catch (e) {
    if (e instanceof AppError) return { status: "BLOCKED", code: e.code, message: e.message };
    console.error("automatic print request failed", e instanceof Error ? e.message : e);
    return { status: "BLOCKED", code: "PRINT_ERROR", message: "Étiquette non préparée (erreur interne). Le rapport est enregistré : utiliser « Imprimer l'étiquette »." };
  }
}

/** The stored label of a print job (served by /etiquette/<job> for the print dialog). */
export async function getJobLabel(jobId: string, actor?: Actor): Promise<{ job: PrintJobDto; svg: string | null }> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.printJob.findUnique({ where: { id: jobId } });
    if (!job) throw notFound("Travail d'impression introuvable.");
    if (actor && job.reportId) await assertReportAccess(actor, job.reportId);
    if (actor && !job.reportId && actor.role !== "ADMIN" && job.requestedById !== actor.userId) throw conflict("PRINT_ACCESS", "Étiquette TEST réservée à son demandeur.");
    // A saved URL must not bypass the correction/supersession checks on creation.
    if (job.reportId && job.method === "PRINT_DIALOG") await assertPrintableReport(tx, job.reportId);
    return { job: toJobDto(job), svg: job.method === "PRINT_DIALOG" ? job.payload : null };
  }, TX_OPTIONS);
}

export async function listReportPrintJobs(reportId: string): Promise<PrintJobDto[]> {
  const jobs = await prisma.printJob.findMany({ where: { reportId }, orderBy: { createdAt: "desc" }, take: 25 });
  return jobs.map(toJobDto);
}

export { reportReference };
