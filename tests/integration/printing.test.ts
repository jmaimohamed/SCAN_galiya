import { restartNok } from "../support/db";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/server/db";
import { sha256Hex } from "@/lib/server/crypto";
import { qrMatrix } from "@/lib/server/qr";
import { openBox, scanItem } from "@/lib/server/services/boxes";
import { confirmPrinterProfile, createPrintJob, getJobLabel, labelContentFromReport, savePrinterProfile } from "@/lib/server/services/printing";
import { svgQrPath, svgTexts } from "../support/label";
import { POST as a4Print } from "@/app/api/reports/[id]/a4-print/route";
import { ctx, request } from "../support/db";
import { boxLabel, finishBox, itemLabel, key, makeActor, nextSerial, openLeased, PN, resetDb } from "../support/db";

let boxSeq = 20_000_000;
type ActorT = Awaited<ReturnType<typeof makeActor>>;

async function finalized(actor: ActorT, qty: number, accepted: number) {
  const raw = boxLabel(qty, String(++boxSeq));
  const { box, leaseToken } = await openLeased(actor, raw);
  for (let i = 0; i < accepted; i++) {
    await scanItem(actor, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
  }
  const r = await finishBox(actor, box.id, leaseToken, { trigger: "GALIA_RESCAN" });
  if (r.kind !== "FINALIZED") throw new Error(r.kind);
  return { report: r.report, raw, boxId: box.id };
}

async function workstation(actor: ActorT, opts: { confirm?: boolean; widthMm?: number; heightMm?: number; name?: string } = {}) {
  const workstationId = randomUUID();
  await savePrinterProfile(actor, { workstationId, name: opts.name ?? "POSTE-CTRL-1", widthMm: opts.widthMm ?? 100, heightMm: opts.heightMm ?? 100 });
  if (opts.confirm !== false) await confirmPrinterProfile(actor, { workstationId, labelChecked: true });
  return workstationId;
}

const job = (actor: ActorT, ws: string, reportId: string | null, kind: "ORIGINAL" | "REPRINT" | "TEST" = "ORIGINAL", reprintReason: string | null = null, k = key()) =>
  createPrintJob(actor, { idempotencyKey: k, kind, reportId, workstationId: ws, reprintReason });

beforeEach(async () => {
  await resetDb();
});

describe("label settings of a workstation", () => {
  it("production labels need a confirmed label size (TEST labels do not)", async () => {
    const op = await makeActor();
    const ws = await workstation(op, { confirm: false });
    const { report } = await finalized(op, 1, 1);
    await expect(job(op, ws, report.id)).rejects.toMatchObject({ code: "LABEL_NOT_CONFIRMED" });
    expect((await job(op, ws, null, "TEST")).job.type).toBe("TEST");
  });

  it("a size change clears the confirmation; a stock too small is refused", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const changed = await savePrinterProfile(op, { workstationId: ws, name: "POSTE-CTRL-1", widthMm: 102, heightMm: 152 });
    expect(changed.confirmedAt).toBeNull();
    const small = await workstation(op, { confirm: false, widthMm: 50, heightMm: 50 });
    await expect(confirmPrinterProfile(op, { workstationId: small, labelChecked: true })).rejects.toMatchObject({ code: "LABEL_LAYOUT" });
    await expect(confirmPrinterProfile(op, { workstationId: ws, labelChecked: false })).rejects.toMatchObject({ status: 400 });
  });

  it("an unconfigured workstation cannot print", async () => {
    const op = await makeActor();
    await expect(job(op, randomUUID(), null, "TEST")).rejects.toMatchObject({ code: "LABEL_NOT_CONFIGURED" });
  });

  it("changing page orientation never changes a previously saved production snapshot", async () => {
    const op = await makeActor();
    const ws = await workstation(op, { widthMm: 110, heightMm: 210 });
    const { report } = await finalized(op, 1, 1);
    const original = (await job(op, ws, report.id)).job;
    const saved = await prisma.printJob.findUniqueOrThrow({ where: { id: original.id } });
    const profile = await savePrinterProfile(op, { workstationId: ws, name: "ANCIEN-MODE", widthMm: 110, heightMm: 210, orientation: "LANDSCAPE" });
    expect(profile.confirmedAt).toBeNull();
    await expect(job(op, ws, report.id, "REPRINT", "Essai de format")).rejects.toMatchObject({ code: "LABEL_NOT_CONFIRMED" });
    await confirmPrinterProfile(op, { workstationId: ws, labelChecked: true });
    const reprint = (await job(op, ws, report.id, "REPRINT", "Essai de format")).job;
    expect(reprint).toMatchObject({ widthMm: 210, heightMm: 110, orientation: "LANDSCAPE" });
    expect((await getJobLabel(saved.id)).svg).toBe(saved.payload);
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({ payload: saved.payload, payloadSha256: saved.payloadSha256, widthMm: 110, heightMm: 210, orientation: "ROTATE_90" });
  });
});

describe("print jobs for the browser print dialog", () => {
  it("OK: stores the exact SVG label (physical size, QR = original GALIA payload) as a DIALOG_REQUESTED job", async () => {
    const op = await makeActor();
    const ws = await workstation(op, { widthMm: 110, heightMm: 210 });
    const { report, raw } = await finalized(op, 2, 2);
    const { job: j } = await job(op, ws, report.id);
    const stored = await prisma.printJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(stored).toMatchObject({ status: "DIALOG_REQUESTED", method: "PRINT_DIALOG", type: "ORIGINAL", printerName: null, printerUid: null, dpi: null, widthMm: 110, heightMm: 210, orientation: "ROTATE_90", templateVersion: "galia-label-v7-width" });
    expect(stored.payloadSha256).toBe(sha256Hex(stored.payload));
    // Plant stock 110 × 210 mm: a roll-size portrait page, with one rotation inside the SVG.
    expect(stored.payload).toMatch(/^<svg[^>]* width="110mm" height="210mm"/);
    expect(stored.payload).toContain('data-rotation="90"');
    expect(stored.payload.match(/rotate\(90\)/g)).toHaveLength(1);
    expect(svgTexts(stored.payload)).toEqual(expect.arrayContaining(["OK", op.username, PN, "2", report.boxSerial, "CONFORME — Quantité et références vérifiées"]));
    const qr = svgQrPath(stored.payload);
    expect(qr).not.toBeNull();
    expect(qr).toMatch(/h(\d+)v\1h-\1z/);
    expect(qrMatrix(raw).length).toBeGreaterThan(20);
    const { svg } = await getJobLabel(j.id);
    expect(svg).toBe(stored.payload);
  });

  it("NOT OK: result, PN, box serial, quantities and the explanation; no QR/barcode, no report reference", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const { report } = await finalized(op, 5, 3);
    const { job: j } = await job(op, ws, report.id);
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(svgTexts(payload)).toEqual(expect.arrayContaining(["NOT OK", "MANQUANT : 2 pièces", PN, op.username, report.boxSerial, "5", "3"]));
    expect(payload).not.toContain("<path");
    expect(payload).not.toContain('data-role="galia-qr"');
    expect(payload).not.toContain(report.reference);
  });

  it("an in-progress box cannot produce an OK/NOT OK label", () => {
    expect(() =>
      labelContentFromReport(
        { result: "IN_PROGRESS", finalizedByUsername: "X", finalizedAt: new Date(), partNumber: "L1", boxSerial: "1234", galiaPayload: "PL1_Q1_S1234", expectedQty: 1, acceptedQty: 0, difference: -1, issues: [], countingVersion: 2, excessQty: 0, wrongPartNumberQty: 0, otherBoxQty: 0, duplicateAttempts: 0, invalidAttempts: 0 },
        false,
      ),
    ).toThrow();
  });

  it("double click / retry with the same key returns the same job; reusing a key differently is refused", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const { report } = await finalized(op, 1, 1);
    const k = key();
    const a = await job(op, ws, report.id, "ORIGINAL", null, k);
    const b = await job(op, ws, report.id, "ORIGINAL", null, k);
    expect(b.job.id).toBe(a.job.id);
    expect(b.replayed).toBe(true);
    await expect(job(op, ws, null, "TEST", null, k)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await prisma.printJob.count()).toBe(1);
  });

  it("one original per report; later labels are explicit, reasoned reprints marked RÉIMPRESSION", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const { report } = await finalized(op, 1, 1);
    const original = await job(op, ws, report.id);
    await expect(job(op, ws, report.id)).rejects.toMatchObject({ code: "ALREADY_PRINTED" });
    await expect(job(op, ws, report.id, "REPRINT", null)).rejects.toMatchObject({ status: 400 });
    const other = await makeActor();
    const otherWs = await workstation(other, { name: "POSTE-2" });
    await expect(job(other, otherWs, report.id, "REPRINT", "Étiquette perdue")).rejects.toMatchObject({ status: 403 });
    await openBox(other, { raw: boxLabel(report.expectedQty, report.boxSerial, report.partNumber) });
    const reprint = await job(other, otherWs, report.id, "REPRINT", "Fenêtre d'impression annulée ou mauvaise imprimante");
    expect(reprint.job).toMatchObject({ type: "REPRINT", originalJobId: original.job.id, requestedBy: other.username, workstationName: "POSTE-2" });
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: reprint.job.id } });
    expect(svgTexts(payload)).toContain("RÉIMPRESSION");
    expect(svgTexts(payload)).toContain(op.username);
    expect(svgTexts(payload)).not.toContain(other.username);
  });

  it("concurrent original requests (different keys) create exactly one original", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const { report } = await finalized(op, 1, 1);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => job(op, ws, report.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.printJob.count({ where: { type: "ORIGINAL" } })).toBe(1);
  });

  it("the job is never marked printed: DIALOG_REQUESTED is final and the payload immutable", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const { report, boxId } = await finalized(op, 1, 1);
    const { job: j } = await job(op, ws, report.id);
    await expect(prisma.printJob.update({ where: { id: j.id }, data: { status: "SENT_TO_PRINTER" } })).rejects.toThrow(/GALIA_GUARD/);
    await expect(prisma.printJob.update({ where: { id: j.id }, data: { payload: "<svg/>" } })).rejects.toThrow(/GALIA_GUARD/);
    for (const data of [{ requestedByUsername: "OTHER" }, { templateVersion: "changed" }, { reprintReason: "changed" }, { payloadSha256: "0".repeat(64) }, { errorMessage: "printed" }]) {
      await expect(prisma.printJob.update({ where: { id: j.id }, data })).rejects.toThrow(/GALIA_GUARD/);
    }
    await expect(prisma.printJob.delete({ where: { id: j.id } })).rejects.toThrow(/GALIA_GUARD/);
    // Printing never touches the saved verification.
    expect((await prisma.box.findUniqueOrThrow({ where: { id: boxId } })).status).toBe("OK");
  });

  it("A4 requests require a session and refuse superseded reports or an open correction", async () => {
    const op = await makeActor();
    const { report, raw } = await finalized(op, 2, 1);
    const doPrint = () => a4Print(request(`/api/reports/${report.id}/a4-print`, { method: "POST", token: op.token }), ctx({ id: report.id }));
    expect((await a4Print(request(`/api/reports/${report.id}/a4-print`, { method: "POST" }), ctx({ id: report.id }))).status).toBe(401);
    expect((await doPrint()).status).toBe(200);
    const correction = await restartNok(op, { raw, startCorrection: true });
    if (correction.kind !== "OPENED") throw new Error(correction.kind);
    expect((await doPrint()).status).toBe(409);
    await scanItem(op, { boxId: correction.box.id, leaseToken: correction.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    await finishBox(op, correction.box.id, correction.leaseToken);
    expect((await doPrint()).status).toBe(409);
    expect(await prisma.auditEvent.count({ where: { type: "A4_PRINT_REQUESTED" } })).toBe(1);
  });

  it("uses the workstation's own label size", async () => {
    const op = await makeActor();
    const ws = await workstation(op, { widthMm: 102, heightMm: 152 });
    const { report } = await finalized(op, 1, 1);
    const { job: j } = await job(op, ws, report.id);
    // Default ROTATE_90: the printed page matches roll width × feed length.
    expect(j).toMatchObject({ widthMm: 102, heightMm: 152, orientation: "ROTATE_90" });
    expect((await getJobLabel(j.id)).svg).toMatch(/width="102mm" height="152mm"/);
  });

  it("TEST label says TEST — NE PAS UTILISER and carries the workstation name", async () => {
    const op = await makeActor();
    const ws = await workstation(op, { confirm: false, name: "POSTE-TEST" });
    const { job: j } = await job(op, ws, null, "TEST");
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: j.id } });
    expect(svgTexts(payload).join(" ")).toContain("TEST — NE PAS UTILISER");
    expect(svgTexts(payload)).toContain("Poste : POSTE-TEST");
    expect(svgQrPath(payload, "test-qr")).not.toBeNull();
  });
});
