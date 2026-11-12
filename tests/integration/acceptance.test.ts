import { restartNok } from "../support/db";
/**
 * Acceptance scenarios 1–20 of the start/end control with honest counting.
 * Server behaviour is exercised through the real route handlers and services on
 * the PostgreSQL test database. Browser-only parts (input-event guards, the
 * single automatic dialog, the blocked-dialog fallback) are covered by the unit
 * tests named in each scenario.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as openRoute } from "@/app/api/boxes/open/route";
import { POST as scanRoute } from "@/app/api/boxes/[id]/scans/route";
import { POST as finalizeRoute } from "@/app/api/boxes/[id]/finalize/route";
import { prisma } from "@/lib/server/db";
import { qrMatrix } from "@/lib/server/qr";
import { finalizeBox, getBoxSummary, openBox, scanItem, type BoxSummary, type FinalizeResult, type OpenBoxResult, type ScanResult } from "@/lib/server/services/boxes";
import { confirmPrinterProfile, createPrintJob, labelContentFromReport, savePrinterProfile, type AutoPrint } from "@/lib/server/services/printing";
import { buildLayout, type QrElement } from "@/lib/zpl/layout";
import { labelPageCss } from "@/lib/label-page";
import { expectedQrPath, svgQrPath, svgTextByRole, svgTexts } from "../support/label";
import { boxLabel, ctx, itemLabel, key, makeActor, nextSerial, PN, request, resetDb } from "../support/db";

type ActorT = Awaited<ReturnType<typeof makeActor>>;
type FinalizeResponse = FinalizeResult & { print: AutoPrint | null };
let boxSeq = 60_000_000;

beforeEach(async () => {
  await resetDb();
});

/** Plant stock by default: roll 110 mm wide, labels 210 mm long, landscape page turned by the driver. */
async function workstation(actor: ActorT, widthMm = 110, heightMm = 210, confirm = true) {
  const workstationId = randomUUID();
  await savePrinterProfile(actor, { workstationId, name: `POSTE-${actor.username}`, widthMm, heightMm, orientation: "LANDSCAPE" });
  if (confirm) await confirmPrinterProfile(actor, { workstationId, labelChecked: true });
  return workstationId;
}

/** One operator page: the same calls the control page makes (routes, cookies, origin). */
function station(actor: ActorT, workstationId: string | null) {
  let lease = "";
  let box: BoxSummary | null = null;
  return {
    get box() {
      return box!;
    },
    get lease() {
      return lease;
    },
    async open(raw: string) {
      const res = await openRoute(request("/api/boxes/open", { token: actor.token, body: { raw } }), {});
      const r = (await res.json()) as OpenBoxResult;
      if (r.kind === "OPENED") {
        lease = r.leaseToken;
        box = r.box;
      }
      return r;
    },
    async scan(raw: string, idempotencyKey = key()) {
      const res = await scanRoute(request(`/api/boxes/${box!.id}/scans`, { token: actor.token, body: { raw, idempotencyKey, leaseToken: lease } }), ctx({ id: box!.id }));
      const r = (await res.json()) as ScanResult;
      box = { ...box!, counts: r.box.counts };
      return r;
    },
    async end(galiaRaw: string | null, observed = box!.counts) {
      const body = {
        leaseToken: lease,
        attemptId: box!.activeAttempt!.id,
        trigger: galiaRaw ? "GALIA_RESCAN" : "MANUAL",
        galiaRaw,
        observed: { events: observed.events, reserved: observed.reserved },
        workstationId,
      };
      const res = await finalizeRoute(request(`/api/boxes/${box!.id}/finalize`, { token: actor.token, body }), ctx({ id: box!.id }));
      expect(res.status).toBe(200);
      return (await res.json()) as FinalizeResponse;
    },
  };
}

async function started(actor: ActorT, qty: number, ws: string | null = null) {
  const raw = boxLabel(qty, String(++boxSeq));
  const s = station(actor, ws);
  const opened = await s.open(raw);
  expect(opened.kind).toBe("OPENED");
  return { s, raw };
}

async function covers(s: ReturnType<typeof station>, n: number, pn = PN) {
  const out: ScanResult[] = [];
  for (let i = 0; i < n; i++) out.push(await s.scan(itemLabel(nextSerial(), pn)));
  return out;
}

describe("start / end of a control", () => {
  it("1: scanning the box GALIA starts the control (PN, serial, expected, counts at zero)", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 5);
    expect(s.box).toMatchObject({ partNumber: PN, expectedQty: 5, galiaPayload: raw, status: "IN_PROGRESS" });
    expect(s.box.activeAttempt).toMatchObject({ number: 1, kind: "INITIAL" });
    expect(s.box.counts).toMatchObject({ expected: 5, distinct: 0, conforming: 0, nonconforming: 0 });
  });

  it("2: five valid covers reach the target; the control stays active (no finalize, no lock, no print)", async () => {
    const op = await makeActor();
    const { s } = await started(op, 5, await workstation(op));
    const results = await covers(s, 5);
    expect(results.every((r) => r.outcome === "ACCEPTED")).toBe(true);
    expect(results[4].box.counts).toMatchObject({ distinct: 5, conforming: 5 });
    const now = await getBoxSummary(s.box.id);
    expect(now.activeAttempt).not.toBeNull();
    expect(now).toMatchObject({ status: "IN_PROGRESS", latestReport: null });
    expect(await prisma.report.count()).toBe(0);
    expect(await prisma.printJob.count()).toBe(0);
    // Scans are still accepted for this box (here: a 6th is recorded as excess, see 4).
    expect((await s.scan(itemLabel(nextSerial()))).outcome).toBe("EXCESS");
  });

  it("3: rescanning the same GALIA ends it OK and requests exactly one print, even when the request is retried", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const { s, raw } = await started(op, 5, ws);
    await covers(s, 5);
    const observed = s.box.counts;
    const first = await s.end(raw, observed);
    expect(first.kind).toBe("FINALIZED");
    if (first.kind !== "FINALIZED") return;
    expect(first.report).toMatchObject({ result: "OK", endTrigger: "GALIA_RESCAN", lines: ["CONFORME — Quantité et références vérifiées"] });
    expect(first.print).toMatchObject({ status: "REQUESTED", replayed: false, job: { type: "ORIGINAL", reportId: first.report.id, widthMm: 210, heightMm: 110, orientation: "LANDSCAPE" } });
    // Same request again (network retry): same report, same job, nothing new.
    const retry = await s.end(raw, observed);
    expect(retry.kind).toBe("ALREADY_FINALIZED");
    expect(retry.kind === "ALREADY_FINALIZED" && retry.report.id).toBe(first.report.id);
    expect(retry.print).toMatchObject({ status: "REQUESTED", replayed: true });
    expect(retry.print?.status === "REQUESTED" && first.print?.status === "REQUESTED" && retry.print.job.id).toBe(first.print?.status === "REQUESTED" ? first.print.job.id : "");
    expect(await prisma.report.count()).toBe(1);
    expect(await prisma.printJob.count()).toBe(1);
  });

  it("4: a sixth distinct cover is recorded (DÉPASSEMENT) and the control ends 6/5 NOT OK", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 5);
    await covers(s, 5);
    const sixth = await s.scan(itemLabel(nextSerial()));
    expect(sixth.outcome).toBe("EXCESS");
    expect(sixth.box.counts).toMatchObject({ distinct: 6, expected: 5, excess: 1 });
    expect(await prisma.activeSerialReservation.findUnique({ where: { serial: sixth.serial! } })).toBeNull();
    const fin = await s.end(raw);
    expect(fin.kind === "FINALIZED" && fin.report.result).toBe("NOK");
    if (fin.kind !== "FINALIZED") return;
    expect(fin.report.counts).toMatchObject({ distinct: 6, conforming: 6, extra: 1 });
    expect(fin.report.lines).toEqual(["EXCÉDENT : 1 pièce"]);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: fin.report.id } })).toMatchObject({ distinctQty: 6, conformingQty: 6, excessQty: 1, extraQty: 1, acceptedQty: 5 });
  });

  it("5: four covers for five end NOT OK with one missing", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 5);
    await covers(s, 4);
    const fin = await s.end(raw);
    expect(fin.kind === "FINALIZED" && fin.report.lines).toEqual(["MANQUANT : 1 pièce"]);
    expect(fin.kind === "FINALIZED" && fin.report.result).toBe("NOK");
  });

  it("6: a wrong PN makes the control NOT OK and reserves nothing", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 5);
    await covers(s, 5);
    const wrong = await s.scan(itemLabel(nextSerial(), "L002815593B96AH"));
    expect(wrong.outcome).toBe("WRONG_PART_NUMBER");
    const fin = await s.end(raw);
    expect(fin.kind === "FINALIZED" && fin.report.result).toBe("NOK");
    expect(fin.kind === "FINALIZED" && fin.report.lines).toEqual(["EXCÉDENT : 1 pièce", "RÉFÉRENCE DIFFÉRENTE : 1 pièce"]);
    expect(await prisma.activeSerialReservation.findUnique({ where: { serial: wrong.serial! } })).toBeNull();
  });

  it("7: a serial already in another box is nonconforming here and the other box keeps its reservation", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const first = await started(a, 2);
    const [taken] = await covers(first.s, 1);
    const second = await started(b, 1);
    const r = await second.s.scan(itemLabel(taken.serial!));
    expect(r.outcome).toBe("DUPLICATE_OTHER_BOX");
    expect(r.box.counts).toMatchObject({ nonconforming: 1, otherBox: 1, conforming: 0 });
    const fin = await second.s.end(second.raw);
    expect(fin.kind === "FINALIZED" && fin.report.lines).toEqual(["MANQUANT : 1 pièce", "SÉRIE DÉJÀ UTILISÉE : 1 pièce"]);
    expect(await prisma.activeSerialReservation.findUniqueOrThrow({ where: { serial: taken.serial! } })).toMatchObject({ boxId: first.s.box.id });
  });

  it("8: scanning the same cover twice keeps the quantity and makes the result NOT OK (duplicate)", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 2);
    const [one] = await covers(s, 2);
    const again = await s.scan(itemLabel(one.serial!));
    expect(again.outcome).toBe("DUPLICATE_SAME_BOX");
    expect(again.box.counts).toMatchObject({ distinct: 2, conforming: 2, duplicates: 1 });
    const fin = await s.end(raw);
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "NOK", lines: ["SCAN EN DOUBLE : 1 tentative"] });
  });

  it("9: an invalid payload keeps the quantity and makes the result NOT OK (invalid)", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 1);
    await covers(s, 1);
    const bad = await s.scan("L002815593B96AG_S");
    expect(bad.outcome).toBe("INVALID_FORMAT");
    expect(bad.box.counts).toMatchObject({ distinct: 1, invalid: 1 });
    const fin = await s.end(raw);
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "NOK", lines: ["FORMAT INVALIDE : 1 tentative"] });
  });

  it("10: a retried request (same key) is neither a duplicate nor a second piece", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 1);
    const k = key();
    const cover = itemLabel(nextSerial());
    await s.scan(cover, k);
    const retry = await s.scan(cover, k);
    expect(retry).toMatchObject({ outcome: "ACCEPTED", replayed: true });
    expect(retry.box.counts).toMatchObject({ distinct: 1, duplicates: 0, events: 1 });
    const fin = await s.end(raw);
    expect(fin.kind === "FINALIZED" && fin.report.result).toBe("OK");
  });

  it("11: another box's GALIA neither ends nor switches the control (client: scan-guards.test)", async () => {
    const op = await makeActor();
    const { s } = await started(op, 1);
    await covers(s, 1);
    const r = await s.end(boxLabel(1, String(++boxSeq)));
    expect(r).toMatchObject({ kind: "GALIA_MISMATCH", print: null });
    expect((await getBoxSummary(s.box.id)).activeAttempt).not.toBeNull();
    expect(await prisma.report.count()).toBe(0);
  });

  it("12: ending waits for queued scans — a stale view is refused, never finalized (client order: scan-guards.test)", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 3);
    await covers(s, 2);
    const stale = s.box.counts;
    await covers(s, 1); // a scan the end request has not seen yet
    const r = await s.end(raw, stale);
    expect(r.kind).toBe("STATE_CHANGED");
    expect(r.kind === "STATE_CHANGED" && r.counts).toMatchObject({ reserved: 3, events: 3 });
    expect((await s.end(raw)).kind).toBe("FINALIZED");
  });

  it("13: an extra scan racing the end is either counted or recorded after the end — never ignored", async () => {
    const op = await makeActor();
    for (let round = 0; round < 6; round++) {
      const { s, raw } = await started(op, 2);
      await covers(s, 2);
      const seen = await getBoxSummary(s.box.id);
      const extra = nextSerial();
      const [fin, scan] = await Promise.all([
        finalizeBox(op, { boxId: s.box.id, leaseToken: s.lease, attemptId: seen.activeAttempt!.id, trigger: "GALIA_RESCAN", galiaRaw: raw, observed: { events: 2, reserved: 2 } }),
        s.scan(itemLabel(extra)),
      ]);
      if (fin.kind === "FINALIZED") {
        expect(scan.outcome).toBe("BOX_NOT_IN_PROGRESS");
        expect(fin.report.result).toBe("OK");
        expect(await prisma.scanAttempt.count({ where: { boxId: s.box.id, serial: extra, outcome: "BOX_NOT_IN_PROGRESS" } })).toBe(1);
      } else {
        expect(fin.kind).toBe("STATE_CHANGED");
        expect(scan.outcome).toBe("EXCESS");
        const end = await s.end(raw);
        expect(end.kind === "FINALIZED" && end.report).toMatchObject({ result: "NOK", lines: ["EXCÉDENT : 1 pièce"] });
      }
    }
  });
});

describe("corrections, labels and printing", () => {
  it("14: an audited correction resolves a 6/5 NOT OK: pieces to remove are confirmed, then OK; history is kept", async () => {
    const op = await makeActor();
    const { s, raw } = await started(op, 2);
    await covers(s, 2);
    const extra = await s.scan(itemLabel(nextSerial()));
    const nok = await s.end(raw);
    if (nok.kind !== "FINALIZED") throw new Error(nok.kind);
    expect(nok.report.result).toBe("NOK");

    const offer = await openBox(op, { raw });
    expect(offer.kind === "CORRECTION_OFFER" && offer.toRemove).toEqual([{ serial: extra.serial, partNumber: PN, reason: "EXCESS" }]);
    await expect(restartNok(op, { raw, startCorrection: true })).rejects.toMatchObject({ code: "REMOVAL_CONFIRMATION_REQUIRED" });
    const corr = await restartNok(op, { raw, startCorrection: true, removalConfirmed: true });
    if (corr.kind !== "OPENED") throw new Error(corr.kind);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { boxId: corr.box.id, type: "BOX_CORRECTION_OPENED" } });
    expect(audit.details).toMatchObject({ removalConfirmed: true, removedPieces: [{ serial: extra.serial, reason: "EXCESS" }], previousIssues: ["EXCESS"] });
    // Full recontrol: the old contents are released and every cover must be scanned again.
    expect(corr.box.counts).toMatchObject({ distinct: 0, conforming: 0, excess: 0, events: 0 });
    for (let i = 0; i < 2; i++) await scanItem(op, { boxId: corr.box.id, leaseToken: corr.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    const fin = await finalizeBox(op, { boxId: corr.box.id, leaseToken: corr.leaseToken, attemptId: corr.box.activeAttempt!.id, trigger: "GALIA_RESCAN", galiaRaw: raw, observed: { events: 2, reserved: 2 } });
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "OK", kind: "CORRECTION", attemptNumber: 2 });
    expect(await prisma.report.count({ where: { boxId: corr.box.id } })).toBe(2);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: nok.report.id } })).toMatchObject({ result: "NOK", excessQty: 1 });
  });

  it("15–17: OK QR is exactly the GALIA payload; NOT OK has no QR or barcode; labels show the report quantities", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const ok = await started(op, 2, ws);
    await covers(ok.s, 2);
    const okEnd = await ok.s.end(ok.raw);
    if (okEnd.kind !== "FINALIZED" || okEnd.print?.status !== "REQUESTED") throw new Error("expected an OK report with a print job");
    const okJob = await prisma.printJob.findUniqueOrThrow({ where: { id: okEnd.print.job.id } });
    const okRow = await prisma.report.findUniqueOrThrow({ where: { id: okEnd.report.id } });
    const qr = buildLayout(labelContentFromReport(okRow, false), { widthMm: 110, heightMm: 210, dpi: 203, accentMode: "UTF8", orientation: "LANDSCAPE" }).elements.find((e): e is QrElement => e.type === "qr")!;
    expect(qr.data).toBe(ok.raw);
    expect(svgQrPath(okJob.payload)).toBe(expectedQrPath(qrMatrix(ok.raw), qr.x, qr.y, qr.magnification));
    expect(svgTextByRole(okJob.payload, "figure-expected")).toBe("2");
    expect(svgTextByRole(okJob.payload, "figure-scanned")).toBe("2");
    expect(svgTextByRole(okJob.payload, "figure-conforming")).toBe("2");
    expect(svgTextByRole(okJob.payload, "figure-nonconforming")).toBe("0");

    const nok = await started(op, 3, ws);
    await covers(nok.s, 2);
    await nok.s.scan(itemLabel(nextSerial(), "LOTHERPN1"));
    await nok.s.scan("junk");
    const nokEnd = await nok.s.end(nok.raw);
    if (nokEnd.kind !== "FINALIZED" || nokEnd.print?.status !== "REQUESTED") throw new Error("expected a NOT OK report with a print job");
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: nokEnd.print.job.id } });
    expect(payload).not.toContain("<path");
    expect(payload).not.toMatch(/data-role="[^"]*qr/);
    expect(svgTexts(payload)).toEqual(expect.arrayContaining(["NOT OK", "MANQUANT : 1 pièce", "RÉFÉRENCE DIFFÉRENTE : 1 pièce", "FORMAT INVALIDE : 1 tentative", op.username, PN]));
    expect(svgTextByRole(payload, "figure-expected")).toBe("3");
    expect(svgTextByRole(payload, "figure-scanned")).toBe("3");
    expect(svgTextByRole(payload, "figure-conforming")).toBe("2");
    expect(svgTextByRole(payload, "figure-nonconforming")).toBe("1");
  });

  it("18: the landscape label is exactly the plant stock (one 210 × 110 mm landscape page, turned once by the driver, nothing clipped)", async () => {
    const op = await makeActor();
    const ws = await workstation(op);
    const { s, raw } = await started(op, 1, ws);
    await covers(s, 1);
    const end = await s.end(raw);
    if (end.print?.status !== "REQUESTED") throw new Error("print expected");
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: end.print.job.id } });
    expect(payload).toMatch(/^<svg[^>]* viewBox="0 0 1680 880" width="210mm" height="110mm"/);
    expect(payload).not.toContain("rotate(");
    const css = labelPageCss(end.print.job.widthMm, end.print.job.heightMm);
    expect(css).toContain("@page { size: 210mm 110mm; margin: 0; }");
    expect(css).toContain(".label-sheet img { display: block; width: 210mm; height: 110mm; }");
    expect(css).not.toMatch(/rotate/);
  });

  it("19: a blocked or impossible print never loses or rolls back the finalization (client fallback: label-print.test)", async () => {
    const op = await makeActor();
    const unconfirmed = await workstation(op, 100, 150, false);
    const { s, raw } = await started(op, 1, unconfirmed);
    await covers(s, 1);
    const end = await s.end(raw);
    expect(end.kind).toBe("FINALIZED");
    expect(end.print).toMatchObject({ status: "BLOCKED", code: "LABEL_NOT_CONFIRMED" });
    const box = await getBoxSummary(s.box.id);
    expect(box).toMatchObject({ status: "OK", activeAttempt: null });
    expect(await prisma.printJob.count()).toBe(0);
    // After confirming the label size, the operator prints the same immutable report.
    await confirmPrinterProfile(op, { workstationId: unconfirmed, labelChecked: true });
    const later = await createPrintJob(op, { idempotencyKey: key(), kind: "ORIGINAL", reportId: box.latestReport!.id, workstationId: unconfirmed, reprintReason: null });
    expect(later.job).toMatchObject({ type: "ORIGINAL", status: "DIALOG_REQUESTED" });
  });

  it("20: several workstations each get their own label request (size, workstation) for their own reports", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const wsA = await workstation(a);
    const wsB = await workstation(b, 104, 200);
    const [boxA, boxB] = [await started(a, 1, wsA), await started(b, 1, wsB)];
    await covers(boxA.s, 1);
    await covers(boxB.s, 1);
    const [endA, endB] = await Promise.all([boxA.s.end(boxA.raw), boxB.s.end(boxB.raw)]);
    expect(endA.print).toMatchObject({ status: "REQUESTED", job: { workstationName: `POSTE-${a.username}`, widthMm: 210, heightMm: 110, requestedBy: a.username } });
    expect(endB.print).toMatchObject({ status: "REQUESTED", job: { workstationName: `POSTE-${b.username}`, widthMm: 200, heightMm: 104, requestedBy: b.username } });
    expect(await prisma.printJob.count()).toBe(2);
  });
});
