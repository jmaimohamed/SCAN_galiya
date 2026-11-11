import "server-only";
import type { BoxStatus, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { notFound } from "../errors";
import { plantDayStartUtc } from "@/lib/time";
import { OUTCOME_TITLES } from "@/lib/labels";
import { toReportSummary, type ReportSummary } from "./boxes";
import { listReportPrintJobs, type PrintJobDto } from "./printing";

export const HISTORY_PAGE_SIZE = 25;

export interface HistoryFilters {
  q: string;
  /** IN_PROGRESS = an attempt is open (initial control or correction); OK / NOK = latest finalized result. */
  status: BoxStatus | "ALL";
  from: string;
  to: string;
  page: number;
}

export interface HistoryRow {
  id: string;
  boxSerial: string;
  partNumber: string;
  expectedQty: number;
  acceptedQty: number;
  status: BoxStatus;
  correctionActive: boolean;
  attemptCount: number;
  createdAt: string;
  createdBy: string;
  finalizedAt: string | null;
  finalizedBy: string | null;
}

/** Server-side filtered, paginated box history. */
export async function searchHistory(f: HistoryFilters): Promise<{ rows: HistoryRow[]; total: number; page: number; pageCount: number }> {
  const and: Prisma.BoxWhereInput[] = [];
  const q = f.q.trim().slice(0, 64);
  if (q) {
    const upper = q.toUpperCase();
    and.push({
      OR: [
        { boxSerial: { contains: upper } },
        { partNumber: { contains: upper } },
        { items: { some: { serial: { startsWith: upper } } } },
        { createdBy: { username: { equals: upper } } },
        { finalizedBy: { username: { equals: upper } } },
        { items: { some: { acceptedBy: { username: { equals: upper } } } } },
      ],
    });
  }
  if (f.status === "IN_PROGRESS") and.push({ activeAttemptId: { not: null } });
  else if (f.status !== "ALL") and.push({ status: f.status });
  const from = f.from ? plantDayStartUtc(f.from) : null;
  const toStart = f.to ? plantDayStartUtc(f.to) : null;
  if (from) and.push({ createdAt: { gte: from } });
  if (toStart) and.push({ createdAt: { lt: new Date(toStart.getTime() + 24 * 3600_000) } });
  const where: Prisma.BoxWhereInput = and.length ? { AND: and } : {};

  const total = await prisma.box.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const page = Math.min(Math.max(1, f.page), pageCount);
  const boxes = await prisma.box.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * HISTORY_PAGE_SIZE,
    take: HISTORY_PAGE_SIZE,
    include: {
      createdBy: { select: { username: true } },
      finalizedBy: { select: { username: true } },
      activeAttempt: { select: { kind: true } },
      _count: { select: { reservations: true, controlAttempts: true } },
    },
  });
  return {
    total,
    page,
    pageCount,
    rows: boxes.map((b) => ({
      id: b.id,
      boxSerial: b.boxSerial,
      partNumber: b.partNumber,
      expectedQty: b.expectedQty,
      acceptedQty: b._count.reservations,
      status: b.status,
      correctionActive: b.activeAttempt?.kind === "CORRECTION",
      attemptCount: b._count.controlAttempts,
      createdAt: b.createdAt.toISOString(),
      createdBy: b.createdBy.username,
      finalizedAt: b.finalizedAt?.toISOString() ?? null,
      finalizedBy: b.finalizedBy?.username ?? null,
    })),
  };
}

export interface AttemptDetail {
  id: string;
  number: number;
  generation: number;
  voidedAt: string | null;
  administrativeRecontrol: boolean;
  kind: "INITIAL" | "CORRECTION";
  status: "IN_PROGRESS" | "FINALIZED";
  startedAt: string;
  startedBy: string;
  finalizedAt: string | null;
  acceptedInAttempt: number;
  report: ReportSummary | null;
  /** Only the latest report of a box can be printed. */
  printable: boolean;
  printJobs: PrintJobDto[];
}

export interface BoxDetail {
  id: string;
  generation: number;
  needsRecontrol: boolean;
  notes: string | null;
  totals: { items: number; attempts: number; rejections: number; events: number; generations: number };
  generations: { number: number; partNumber: string; boxSerial: string; expectedQty: number; galiaPayload: string; startedAt: string; voidedAt: string | null; voidReason: string | null; voidedBy: string | null }[];
  boxSerial: string;
  partNumber: string;
  expectedQty: number;
  acceptedQty: number;
  status: BoxStatus;
  correctionActive: boolean;
  galiaPayload: string;
  createdAt: string;
  createdBy: string;
  currentOwner: string | null;
  attempts: AttemptDetail[];
  items: { id: string; serial: string; partNumber: string; rawPayload: string; acceptedAt: string; acceptedBy: string; attemptNumber: number; generation: number; voidedAt: string | null; voidedById: string | null; voidReason: string | null }[];
  rejections: { id: string; outcome: string; title: string; raw: string; rawLength: number; message: string | null; createdAt: string; username: string; attemptNumber: number | null }[];
  events: { id: string; type: string; username: string | null; createdAt: string; details: unknown }[];
}

export async function getBoxDetail(boxId: string, pages: { items?: number; attempts?: number; rejections?: number; events?: number; generations?: number } = {}): Promise<BoxDetail> {
  const skip = (page = 1) => (Math.max(1, Math.min(1000000, Math.floor(page) || 1)) - 1) * HISTORY_PAGE_SIZE;
  const box = await prisma.box.findUnique({
    where: { id: boxId },
    include: {
      createdBy: { select: { username: true } },
      generations: { orderBy: { number: "desc" }, take: HISTORY_PAGE_SIZE, skip: skip(pages.generations) },
      _count: { select: { items: true, controlAttempts: true, generations: true, reservations: true } },
      controlAttempts: {
        orderBy: { number: "desc" }, take: HISTORY_PAGE_SIZE, skip: skip(pages.attempts),
        include: { startedBy: { select: { username: true } }, report: true, _count: { select: { items: true } } },
      },
      items: {
        orderBy: { acceptedAt: "desc" }, take: HISTORY_PAGE_SIZE, skip: skip(pages.items),
        include: { acceptedBy: { select: { username: true } }, controlAttempt: { select: { number: true } } },
      },
      scanAttempts: {
        where: { outcome: { not: "ACCEPTED" } },
        orderBy: { createdAt: "desc" },
        take: HISTORY_PAGE_SIZE, skip: skip(pages.rejections),
        include: { user: { select: { username: true } }, controlAttempt: { select: { number: true } } },
      },
    },
  });
  if (!box) throw notFound("Boîte introuvable.");
  const latestId = box.currentReportId;
  const [events, owner, jobsPerAttempt, rejectionCount, eventCount, voiders] = await Promise.all([
    prisma.auditEvent.findMany({ where: { boxId }, orderBy: { createdAt: "desc" }, take: HISTORY_PAGE_SIZE, skip: skip(pages.events) }),
    box.ownerUserId ? prisma.user.findUnique({ where: { id: box.ownerUserId }, select: { username: true } }) : null,
    Promise.all(box.controlAttempts.map((a) => (a.report ? listReportPrintJobs(a.report.id) : Promise.resolve([])))),
    prisma.scanAttempt.count({ where: { boxId, outcome: { not: "ACCEPTED" } } }),
    prisma.auditEvent.count({ where: { boxId } }),
    prisma.user.findMany({ where: { id: { in: box.generations.flatMap((g) => g.voidedById ? [g.voidedById] : []) } }, select: { id: true, username: true } }),
  ]);
  return {
    id: box.id,
    generation: box.generation,
    needsRecontrol: box.needsRecontrol,
    notes: box.notes,
    totals: { items: box._count.items, attempts: box._count.controlAttempts, generations: box._count.generations, rejections: rejectionCount, events: eventCount },
    generations: box.generations.map((g) => ({ number: g.number, partNumber: g.partNumber, boxSerial: g.boxSerial, expectedQty: g.expectedQty, galiaPayload: g.galiaPayload, startedAt: g.startedAt.toISOString(), voidedAt: g.voidedAt?.toISOString() ?? null, voidReason: g.voidReason, voidedBy: voiders.find((u) => u.id === g.voidedById)?.username ?? null })),
    boxSerial: box.boxSerial,
    partNumber: box.partNumber,
    expectedQty: box.expectedQty,
    acceptedQty: box._count.reservations,
    status: box.status,
    correctionActive: box.activeAttemptId !== null && box.controlAttempts.some((a) => a.id === box.activeAttemptId && a.kind === "CORRECTION"),
    galiaPayload: box.galiaPayload,
    createdAt: box.createdAt.toISOString(),
    createdBy: box.createdBy.username,
    currentOwner: owner?.username ?? null,
    attempts: box.controlAttempts.map((a, i) => ({
      id: a.id,
      number: a.number,
      generation: a.generation,
      voidedAt: a.voidedAt?.toISOString() ?? null,
      administrativeRecontrol: a.administrativeRecontrol,
      kind: a.kind,
      status: a.status,
      startedAt: a.startedAt.toISOString(),
      startedBy: a.startedBy.username,
      finalizedAt: a.finalizedAt?.toISOString() ?? null,
      acceptedInAttempt: a._count.items,
      report: a.report ? toReportSummary(a.report) : null,
      printable: !!a.report && a.report.id === latestId && box.activeAttemptId === null && !box.needsRecontrol,
      printJobs: jobsPerAttempt[i],
    })),
    items: box.items.map((i) => ({
      id: i.id,
      serial: i.serial,
      partNumber: i.partNumber,
      rawPayload: i.rawPayload,
      acceptedAt: i.acceptedAt.toISOString(),
      acceptedBy: i.acceptedBy.username,
      attemptNumber: i.controlAttempt.number,
      generation: i.generation,
      voidedAt: i.voidedAt?.toISOString() ?? null,
      voidedById: i.voidedById,
      voidReason: i.voidReason,
    })),
    rejections: box.scanAttempts.map((a) => {
      const detail = (a.detail ?? {}) as Record<string, unknown>;
      return {
        id: a.id,
        outcome: a.outcome,
        title: OUTCOME_TITLES[a.outcome],
        raw: a.rawPayload,
        rawLength: a.rawLength,
        message: typeof detail.message === "string" ? detail.message : typeof detail.boxSerial === "string" ? `Boîte ${detail.boxSerial}` : null,
        createdAt: a.createdAt.toISOString(),
        username: a.user.username,
        attemptNumber: a.controlAttempt?.number ?? null,
      };
    }),
    events: events.map((e) => ({ id: e.id.toString(), type: e.type, username: e.username, createdAt: e.createdAt.toISOString(), details: e.details })),
  };
}
