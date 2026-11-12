import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/server/db";
import { sha256Hex } from "@/lib/server/crypto";
import type { Actor, Role } from "@/lib/server/errors";
import { finalizeBox, getBoxSummary, openBox, type EndTrigger } from "@/lib/server/services/boxes";

/** Empty every table of the TEST database (TRUNCATE does not fire the row guards). */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PrintJob", "PrinterProfile", "Report", "AcceptedItem", "ScanAttempt", "Box", "AuditEvent", "LoginAttempt", "Session", "User" RESTART IDENTITY CASCADE`,
  );
}

let userSeq = 0;

/** Create a user and an active session; returns the server-side actor and the raw cookie token. */
export async function makeActor(role: Role = "OPERATOR", username?: string): Promise<Actor & { token: string }> {
  userSeq += 1;
  const name = username ?? `OP${String(userSeq).padStart(3, "0")}`;
  const user = await prisma.user.upsert({
    where: { username: name },
    update: {},
    create: { username: name, role, passwordHash: "test-only-not-a-hash" },
  });
  return newSession(user.id, user.username, user.role);
}

/** A second session (another tab/workstation) for an existing user. */
export async function newSession(userId: string, username: string, role: Role): Promise<Actor & { token: string }> {
  const token = randomBytes(32).toString("base64url");
  const id = sha256Hex(token);
  await prisma.session.create({ data: { id, userId, expiresAt: new Date(Date.now() + 3600_000) } });
  return { userId, username, displayName: null, role, sessionId: id, token };
}

export async function openLeased(actor: Actor, raw: string) {
  const r = await openBox(actor, { raw });
  if (r.kind !== "OPENED") throw new Error(`expected OPENED, got ${r.kind}`);
  return { box: r.box, leaseToken: r.leaseToken };
}

/** Follow the same offer/confirmation contract as the operator UI. */
export async function restartNok(actor: Actor, input: { raw?: string; boxId?: string; startCorrection?: boolean; removalConfirmed?: boolean }) {
  const offer = await openBox(actor, input.raw !== undefined ? { raw: input.raw } : { boxId: input.boxId });
  if (offer.kind !== "CORRECTION_OFFER") return offer;
  return openBox(actor, { ...input, startCorrection: true, correctionReportId: offer.report.id });
}

/**
 * End the open control the way the control page does: with the attempt id and the
 * counts the operator currently sees (precondition), by GALIA rescan or manually.
 */
export async function finishBox(actor: Actor, boxId: string, leaseToken: string, opts: { trigger?: EndTrigger; galiaRaw?: string | null; note?: string | null } = {}) {
  const s = await getBoxSummary(boxId);
  if (!s.activeAttempt) throw new Error("no open attempt");
  const trigger = opts.trigger ?? "MANUAL";
  return finalizeBox(actor, {
    boxId,
    leaseToken,
    attemptId: s.activeAttempt.id,
    trigger,
    galiaRaw: opts.galiaRaw ?? (trigger === "GALIA_RESCAN" ? s.galiaPayload : null),
    observed: { events: s.counts.events, reserved: s.counts.reserved },
    note: opts.note ?? null,
  });
}

let serialSeq = 70_000_000_000;
export function nextSerial(): string {
  serialSeq += 1;
  return String(serialSeq);
}

export const PN = "L002815593B96AG";
export function boxLabel(qty: number, serial: string, pn = PN): string {
  return `P${pn}_Q${qty}_S${serial}`;
}
export function itemLabel(serial: string, pn = PN): string {
  return `${pn}_S${serial}`;
}

export const key = () => randomUUID();

export const ORIGIN = "http://localhost:3006";

/** Build a request as the browser would send it to a route handler. */
export function request(
  url: string,
  init: { method?: string; body?: unknown; token?: string; origin?: string | null; headers?: Record<string, string> } = {},
): NextRequest {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  if (init.token) headers.cookie = `galia_session=${init.token}`;
  return new NextRequest(new URL(url, ORIGIN), {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export function ctx<P extends Record<string, string>>(params: P) {
  return { params: Promise.resolve(params) };
}
