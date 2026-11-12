import { restartNok } from "../support/db";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/server/db";
import { finalizeBox, openBox, scanItem } from "@/lib/server/services/boxes";
import { POST as openRoute } from "@/app/api/boxes/open/route";
import {
  confirmPrinterProfile,
  createPrintJob,
  getJobLabel,
  labelContentFromReport,
  savePrinterProfile,
} from "@/lib/server/services/printing";
import { qrMatrix } from "@/lib/server/qr";
import { buildLayout, type QrElement } from "@/lib/zpl/layout";
import { expectedQrPath, svgQrPath, svgTexts as texts } from "../support/label";
import { boxLabel, finishBox, itemLabel, key, makeActor, nextSerial, openLeased, PN, request, resetDb } from "../support/db";

type ActorT = Awaited<ReturnType<typeof makeActor>>;
let boxSeq = 30_000_000;

beforeEach(async () => {
  await resetDb();
});

async function accept(actor: ActorT, boxId: string, leaseToken: string, serials: string[]) {
  for (const s of serials) {
    const r = await scanItem(actor, { boxId, leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(r.outcome).toBe("ACCEPTED");
  }
}

/** The supplied example: GALIA expects 20, only 18 accepted, finalized NOT OK. */
async function nokBox(actor: ActorT, expected = 20, accepted = 18) {
  const raw = boxLabel(expected, String(++boxSeq));
  const { box, leaseToken } = await openLeased(actor, raw);
  const serials = Array.from({ length: accepted }, () => nextSerial());
  await accept(actor, box.id, leaseToken, serials);
  const fin = await finishBox(actor, box.id, leaseToken, { trigger: "GALIA_RESCAN" });
  if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
  expect(fin.report).toMatchObject({ result: "NOK", acceptedQty: accepted, expectedQty: expected, kind: "INITIAL", attemptNumber: 1, issues: ["MISSING"] });
  return { raw, boxId: box.id, serials, report: fin.report, oldLeaseToken: leaseToken, oldAttemptId: box.activeAttempt!.id };
}

async function startCorrection(actor: ActorT, raw: string, removalConfirmed?: boolean) {
  const r = await restartNok(actor, { raw, startCorrection: true, removalConfirmed });
  if (r.kind !== "OPENED") throw new Error(`expected OPENED, got ${r.kind}`);
  return r;
}

async function confirmedWorkstation(admin: ActorT, name = "POSTE-A") {
  const workstationId = randomUUID();
  await savePrinterProfile(admin, { workstationId, name, widthMm: 100, heightMm: 100 });
  await confirmPrinterProfile(admin, { workstationId, labelChecked: true });
  return workstationId;
}

describe("reopening a NOT OK box", () => {
  it("1–2: an incomplete box finalizes NOT OK; rescanning it asks YES/NO without changing anything", async () => {
    const a = await makeActor();
    const { raw, boxId, report } = await nokBox(a);
    const offer = await openBox(a, { raw: `${raw}\r\n` });
    expect(offer.kind).toBe("CORRECTION_OFFER");
    if (offer.kind !== "CORRECTION_OFFER") return;
    expect(offer.report).toMatchObject({ id: report.id, expectedQty: 20, acceptedQty: 18, result: "NOK", lines: ["MANQUANT : 2 pièces"] });
    expect(offer.toRemove).toEqual([]);
    const box = await prisma.box.findUniqueOrThrow({ where: { id: boxId } });
    expect(box).toMatchObject({ status: "NOK", activeAttemptId: null, ownerSessionId: null });
    expect(await prisma.controlAttempt.count({ where: { boxId } })).toBe(1);
  });

  it("3: NO keeps the NOT OK result and no cover can be added", async () => {
    const a = await makeActor();
    const { raw, boxId } = await nokBox(a);
    await openBox(a, { raw }); // offer shown, operator answers NO: nothing else is called
    const lease = "x".repeat(43);
    const r = await scanItem(a, { boxId, leaseToken: lease, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(r.outcome).toBe("BOX_NOT_IN_PROGRESS");
    expect(await prisma.acceptedItem.count({ where: { boxId } })).toBe(18);
    expect((await prisma.box.findUniqueOrThrow({ where: { id: boxId } })).status).toBe("NOK");
  });

  it("4–5: YES releases 18 old assignments, starts at zero and requires twenty fresh scans", async () => {
    const a = await makeActor();
    const corrector = await makeActor();
    const { raw, boxId, report, serials } = await nokBox(a);
    const opened = await startCorrection(corrector, raw);
    expect(opened.correctionStarted).toBe(true);
    expect(opened.box).toMatchObject({ generation: 2, acceptedCount: 0, remaining: 20, status: "IN_PROGRESS", needsRecontrol: true });
    expect(opened.box.activeAttempt).toMatchObject({ number: 2, kind: "CORRECTION", startedBy: corrector.username });
    expect(opened.box.previousReport?.id).toBe(report.id);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { boxId, type: "BOX_CORRECTION_OPENED" } });
    expect(event.username).toBe(corrector.username);
    expect(event.details).toMatchObject({ attemptNumber: 2, previousResult: "NOK", previousReportId: report.id, previousAcceptedQty: 18 });
    expect(await prisma.acceptedItem.count({ where: { boxId, voidedAt: { not: null } } })).toBe(18);
    expect(await prisma.activeSerialReservation.count({ where: { boxId } })).toBe(0);
    await accept(corrector, boxId, opened.leaseToken, serials);

    const first = await scanItem(corrector, { boxId, leaseToken: opened.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(first.box.acceptedCount).toBe(19);
    expect(first.item?.attemptNumber).toBe(2);
    const second = await scanItem(corrector, { boxId, leaseToken: opened.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(second.box).toMatchObject({ acceptedCount: 20, remaining: 0 });
    expect(await prisma.acceptedItem.count({ where: { boxId, controlAttempt: { number: 2 }, voidedAt: null } })).toBe(20);
  });

  it("6–8: same-box duplicates, other-box serials and wrong PN never count as conforming during a correction", async () => {
    const a = await makeActor();
    const { raw, boxId, serials } = await nokBox(a);
    const other = await openLeased(a, boxLabel(5, String(++boxSeq)));
    const foreign = nextSerial();
    await accept(a, other.box.id, other.leaseToken, [foreign]);

    const { leaseToken } = await startCorrection(a, raw);
    await accept(a, boxId, leaseToken, [serials[3]]); // first scan in the new generation is valid
    const sameBox = await scanItem(a, { boxId, leaseToken, raw: itemLabel(serials[3]), idempotencyKey: key() });
    expect(sameBox).toMatchObject({ outcome: "DUPLICATE_SAME_BOX", title: "SCAN EN DOUBLE — déjà compté" });
    const otherBox = await scanItem(a, { boxId, leaseToken, raw: itemLabel(foreign), idempotencyKey: key() });
    expect(otherBox).toMatchObject({ outcome: "DUPLICATE_OTHER_BOX", title: "SÉRIE DÉJÀ UTILISÉE dans une autre boîte" });
    expect(otherBox.duplicate?.boxSerial).toBe(other.box.boxSerial);
    const rejectedSerial = nextSerial();
    const wrongPn = await scanItem(a, { boxId, leaseToken, raw: itemLabel(rejectedSerial, "L002815593B96AH"), idempotencyKey: key() });
    expect(wrongPn).toMatchObject({ outcome: "WRONG_PART_NUMBER", expectedPartNumber: PN, partNumber: "L002815593B96AH" });
    const malformed = await scanItem(a, { boxId, leaseToken, raw: PN, idempotencyKey: key() });
    expect(malformed.outcome).toBe("INVALID_FORMAT");
    expect(malformed.box.acceptedCount).toBe(1);
    expect(malformed.box.counts).toMatchObject({ reserved: 1, conforming: 1, nonconforming: 2, wrongPartNumber: 1, otherBox: 1, duplicates: 1, invalid: 1 });

    // The same serial again in this control (even with the right PN) is a repeated identity, never a new piece.
    const again = await scanItem(a, { boxId, leaseToken, raw: itemLabel(rejectedSerial), idempotencyKey: key() });
    expect(again.outcome).toBe("DUPLICATE_SAME_BOX");
    // A rejected scan reserved nothing: that serial is accepted in another box.
    const elsewhere = await openLeased(a, boxLabel(5, String(++boxSeq)));
    const ok = await scanItem(a, { boxId: elsewhere.box.id, leaseToken: elsewhere.leaseToken, raw: itemLabel(rejectedSerial), idempotencyKey: key() });
    expect(ok.outcome).toBe("ACCEPTED");
  });

  it("9: an incomplete recontrol has only its fresh count, and the next recontrol starts at zero again", async () => {
    const a = await makeActor();
    const { raw, boxId, report: first } = await nokBox(a);
    const { leaseToken } = await startCorrection(a, raw);
    await scanItem(a, { boxId, leaseToken, raw: itemLabel(nextSerial(), "L002815593B96AH"), idempotencyKey: key() });
    await accept(a, boxId, leaseToken, [nextSerial()]);

    const fin = await finishBox(a, boxId, leaseToken, { trigger: "GALIA_RESCAN" });
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "NOK", acceptedQty: 1, difference: -19, kind: "CORRECTION", attemptNumber: 2, issues: ["MISSING", "WRONG_PART_NUMBER"] });
    expect(fin.kind === "FINALIZED" && fin.report.lines).toEqual(["MANQUANT : 19 pièces", "RÉFÉRENCE DIFFÉRENTE : 1 pièce"]);
    expect(fin.kind === "FINALIZED" && fin.report.id).not.toBe(first.id);

    const offer = await openBox(a, { raw });
    expect(offer.kind === "CORRECTION_OFFER" && offer.report.acceptedQty).toBe(1);
    // The wrong-PN piece is physically in the box: the next correction needs an audited removal confirmation.
    expect(offer.kind === "CORRECTION_OFFER" && offer.toRemove).toEqual([expect.objectContaining({ reason: "WRONG_PART_NUMBER", partNumber: "L002815593B96AH" })]);
    await expect(restartNok(a, { raw, startCorrection: true })).rejects.toMatchObject({ code: "REMOVAL_CONFIRMATION_REQUIRED" });
    const third = await startCorrection(a, raw, true);
    expect(third.box.activeAttempt).toMatchObject({ number: 3, kind: "CORRECTION" });
    expect(third.box.acceptedCount).toBe(0);
    expect(third.box.generation).toBe(3);
    expect(await prisma.report.count({ where: { boxId } })).toBe(2);
  });

  it("10 & 12: a complete correction is OK; afterwards the box is read-only and never offers a correction", async () => {
    const a = await makeActor();
    const { raw, boxId } = await nokBox(a, 3, 1);
    const { leaseToken } = await startCorrection(a, raw);
    await accept(a, boxId, leaseToken, [nextSerial(), nextSerial(), nextSerial()]);
    const fin = await finishBox(a, boxId, leaseToken, { trigger: "GALIA_RESCAN" });
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "OK", acceptedQty: 3, kind: "CORRECTION", attemptNumber: 2, issues: [] });
    const box = await prisma.box.findUniqueOrThrow({ where: { id: boxId } });
    expect(box).toMatchObject({ status: "OK", activeAttemptId: null });

    expect((await openBox(a, { raw })).kind).toBe("FINALIZED");
    expect((await restartNok(a, { raw, startCorrection: true })).kind).toBe("FINALIZED");
    expect(await prisma.controlAttempt.count({ where: { boxId } })).toBe(2);
    await expect(prisma.box.update({ where: { id: boxId }, data: { status: "NOK" } })).rejects.toThrow(/GALIA_GUARD/);
  });

  it("an OK box from the first control never enters the correction flow", async () => {
    const a = await makeActor();
    const raw = boxLabel(1, String(++boxSeq));
    const { box, leaseToken } = await openLeased(a, raw);
    await accept(a, box.id, leaseToken, [nextSerial()]);
    await finishBox(a, box.id, leaseToken);
    expect((await restartNok(a, { raw, startCorrection: true })).kind).toBe("FINALIZED");
  });

  it("13: two workstations cannot open/correct the same box simultaneously", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const { raw, boxId } = await nokBox(a);
    const [ra, rb] = await Promise.all([restartNok(a, { raw, startCorrection: true }), restartNok(b, { raw, startCorrection: true })]);
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(["OPENED", "OWNED"]);
    expect(await prisma.controlAttempt.count({ where: { boxId } })).toBe(2);
    const winner = ra.kind === "OPENED" ? { actor: a, r: ra } : { actor: b, r: rb };
    const loser = ra.kind === "OPENED" ? b : a;
    if (winner.r.kind !== "OPENED") return;
    // The other workstation cannot write without an explicit, audited takeover.
    const refused = await scanItem(loser, { boxId, leaseToken: winner.r.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(refused.outcome).toBe("NOT_BOX_OWNER");
  });

  it("14: concurrent scans during a correction never reserve beyond the GALIA quantity (the rest is recorded excess)", async () => {
    const a = await makeActor();
    const { raw, boxId } = await nokBox(a, 2, 1);
    const { leaseToken } = await startCorrection(a, raw);
    const results = await Promise.all(Array.from({ length: 6 }, () => scanItem(a, { boxId, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() })));
    expect(results.filter((r) => r.outcome === "ACCEPTED")).toHaveLength(2);
    expect(results.filter((r) => r.outcome === "EXCESS")).toHaveLength(4);
    expect(await prisma.acceptedItem.count({ where: { boxId, voidedAt: null } })).toBe(2);
    expect(await prisma.acceptedItem.count({ where: { boxId, voidedAt: { not: null } } })).toBe(1);
  });

  it("identity cannot change during a correction; conflicting metadata is blocked", async () => {
    const a = await makeActor();
    const { raw, boxId } = await nokBox(a);
    await startCorrection(a, raw);
    const serial = raw.split("_S")[1];
    expect((await openBox(a, { raw: boxLabel(21, serial) })).kind).toBe("CONFLICT");
    await expect(prisma.box.update({ where: { id: boxId }, data: { expectedQty: 18 } })).rejects.toThrow(/GALIA_GUARD/);
    await expect(prisma.box.update({ where: { id: boxId }, data: { galiaPayload: "PL1_Q1_S1234" } })).rejects.toThrow(/GALIA_GUARD/);
  });
});

describe("zero restart integrity", () => {
  it("releases old serials for another box, rejects their reassignment and rejects old scan retries/leases", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const old = await nokBox(a, 2, 1);
    const oldScan = await prisma.scanAttempt.findFirstOrThrow({ where: { boxId: old.boxId, outcome: "ACCEPTED" } });
    const original = await prisma.report.findUniqueOrThrow({ where: { id: old.report.id } });
    const fresh = await startCorrection(a, old.raw);
    const other = await openLeased(b, boxLabel(1, String(++boxSeq)));
    await accept(b, other.box.id, other.leaseToken, old.serials);
    const duplicate = await scanItem(a, { boxId: old.boxId, leaseToken: fresh.leaseToken, raw: itemLabel(old.serials[0]), idempotencyKey: key() });
    expect(duplicate).toMatchObject({ outcome: "DUPLICATE_OTHER_BOX", box: { acceptedCount: 0 } });
    await expect(scanItem(a, { boxId: old.boxId, leaseToken: old.oldLeaseToken, raw: oldScan.rawPayload, idempotencyKey: oldScan.idempotencyKey })).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    expect((await scanItem(a, { boxId: old.boxId, leaseToken: old.oldLeaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() })).outcome).toBe("NOT_BOX_OWNER");
    expect(await prisma.activeSerialReservation.findUnique({ where: { serial: old.serials[0] } })).toMatchObject({ boxId: other.box.id });
    expect(await prisma.acceptedItem.count({ where: { serial: old.serials[0] } })).toBe(2);
    expect(await prisma.report.findUniqueOrThrow({ where: { id: original.id } })).toEqual(original);
  });

  it("requires the exact offered report; stale confirmations cannot restart the next NOT OK", async () => {
    const a = await makeActor();
    const old = await nokBox(a, 2, 1);
    const missing = await openRoute(request("/api/boxes/open", { token: a.token, body: { raw: old.raw, startCorrection: true } }), {});
    expect(missing.status).toBe(400);
    const fresh = await startCorrection(a, old.raw);
    const next = await finishBox(a, old.boxId, fresh.leaseToken);
    if (next.kind !== "FINALIZED") throw new Error(next.kind);
    expect(next.report).toMatchObject({ result: "NOK", acceptedQty: 0 });
    await expect(openBox(a, { raw: old.raw, startCorrection: true, correctionReportId: old.report.id })).rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
    expect(await prisma.box.findUniqueOrThrow({ where: { id: old.boxId } })).toMatchObject({ generation: 2, activeAttemptId: null, currentReportId: next.report.id });
  });

  it("serializes simultaneous confirmations, old scans and finalization retries without resurrecting contents", async () => {
    const a = await makeActor(); const b = await makeActor();
    const old = await nokBox(a, 2, 1);
    const body = { raw: old.raw, startCorrection: true, correctionReportId: old.report.id };
    const results = await Promise.allSettled([
      openBox(a, body), openBox(b, body),
      scanItem(a, { boxId: old.boxId, leaseToken: old.oldLeaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() }),
      finalizeBox(a, { boxId: old.boxId, leaseToken: old.oldLeaseToken, attemptId: old.oldAttemptId, trigger: "MANUAL", observed: { events: 1, reserved: 1 } }),
    ]);
    const openings = results.slice(0, 2).map((r) => r.status === "fulfilled" && "kind" in r.value ? r.value.kind : "ERROR").sort();
    expect(openings).toEqual(["OPENED", "OWNED"]);
    expect(await prisma.box.findUniqueOrThrow({ where: { id: old.boxId } })).toMatchObject({ generation: 2, currentReportId: null, status: "IN_PROGRESS" });
    expect(await prisma.activeSerialReservation.count({ where: { boxId: old.boxId } })).toBe(0);
    expect(await prisma.controlGeneration.count({ where: { boxId: old.boxId } })).toBe(2);
    expect(await prisma.report.count({ where: { boxId: old.boxId } })).toBe(1);
    const stale = results[2];
    expect(stale.status === "fulfilled" && "outcome" in stale.value && stale.value.outcome).not.toBe("ACCEPTED");
    const end = results[3];
    if (end.status === "fulfilled") expect("kind" in end.value && end.value.kind).toBe("ALREADY_FINALIZED");
    else expect(end.reason).toMatchObject({ code: "CONTROL_INVALIDATED" });
  });

  it("does not grant a disabled/revoked session permission to release a NOT OK control", async () => {
    const a = await makeActor();
    const old = await nokBox(a, 2, 1);
    await prisma.session.update({ where: { id: a.sessionId }, data: { revokedAt: new Date() } });
    await expect(openBox(a, { raw: old.raw, startCorrection: true, correctionReportId: old.report.id })).rejects.toThrow(/GALIA_GUARD/);
    expect(await prisma.box.findUniqueOrThrow({ where: { id: old.boxId } })).toMatchObject({ generation: 1, status: "NOK", currentReportId: old.report.id });
    expect(await prisma.activeSerialReservation.count({ where: { boxId: old.boxId } })).toBe(1);
  });

  it("the NOT OK capability cannot void an OK box or another target's contents", async () => {
    const a = await makeActor();
    const old = await nokBox(a, 2, 1);
    const other = await openLeased(a, boxLabel(1, String(++boxSeq)));
    await accept(a, other.box.id, other.leaseToken, [nextSerial()]);
    const end = await finishBox(a, other.box.id, other.leaseToken);
    if (end.kind !== "FINALIZED") throw new Error(end.kind);
    const item = await prisma.acceptedItem.findFirstOrThrow({ where: { boxId: other.box.id } });
    await expect(prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('galia.nok_restart_session', ${a.sessionId}, true), set_config('galia.nok_restart_box', ${old.boxId}, true), set_config('galia.nok_restart_report', ${old.report.id}, true), set_config('galia.nok_restart_reason', 'test reason', true)`;
      await tx.acceptedItem.update({ where: { id: item.id }, data: { voidedAt: new Date(), voidedById: a.userId, voidReason: "test reason" } });
    })).rejects.toThrow(/GALIA_GUARD/);
    expect(await prisma.activeSerialReservation.findUnique({ where: { serial: item.serial } })).toMatchObject({ boxId: other.box.id });
    expect((await openBox(a, { raw: other.box.galiaPayload, startCorrection: true, correctionReportId: end.report.id })).kind).toBe("FINALIZED");
  });
});

describe("reports and labels across attempts", () => {
  it("11: the original NOT OK report, its print job and payload stay unchanged; old reports are not printable", async () => {
    const op = await makeActor();
    const admin = await makeActor("ADMIN");
    const ws = await confirmedWorkstation(admin);
    const { raw, boxId, report: nok } = await nokBox(op, 3, 1);

    // Print the NOT OK label of the first attempt.
    const { job } = await createPrintJob(op, { idempotencyKey: key(), kind: "ORIGINAL", reportId: nok.id, workstationId: ws, reprintReason: null });
    const nokRowBefore = await prisma.report.findUniqueOrThrow({ where: { id: nok.id } });
    const nokJobBefore = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(texts(nokJobBefore.payload)).toEqual(expect.arrayContaining(["NOT OK", "MANQUANT : 2 pièces"]));
    expect(svgQrPath(nokJobBefore.payload)).toBeNull();
    expect(nokJobBefore.payload).not.toContain("<path"); // All encoded symbols in this renderer use paths.

    // While the correction is open, production printing is blocked (even a reprint of the NOT OK).
    const corr = await startCorrection(op, raw);
    await expect(getJobLabel(job.id)).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });
    await expect(
      createPrintJob(op, { idempotencyKey: key(), kind: "REPRINT", reportId: nok.id, workstationId: ws, reprintReason: "Étiquette perdue" }),
    ).rejects.toMatchObject({ code: "CONTROL_INVALIDATED" });

    await accept(op, boxId, corr.leaseToken, [nextSerial(), nextSerial(), nextSerial()]);
    const fin = await finishBox(op, boxId, corr.leaseToken, { trigger: "GALIA_RESCAN" });
    if (fin.kind !== "FINALIZED") throw new Error(fin.kind);

    // The old report and its job are byte-for-byte unchanged.
    expect(await prisma.report.findUniqueOrThrow({ where: { id: nok.id } })).toEqual(nokRowBefore);
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(nokJobBefore);
    await expect(getJobLabel(job.id)).rejects.toMatchObject({ code: "REPORT_SUPERSEDED" });
    // An old report is never re-rendered with the newer quantity; it is simply no longer printable.
    expect(labelContentFromReport(nokRowBefore, true)).toMatchObject({ template: "NOT_OK", figures: { conforming: 1, expected: 3, lines: ["MANQUANT : 2 pièces"] } });
    await expect(
      createPrintJob(op, { idempotencyKey: key(), kind: "REPRINT", reportId: nok.id, workstationId: ws, reprintReason: "x pour test" }),
    ).rejects.toMatchObject({ code: "REPORT_SUPERSEDED" });

    // The new OK report prints an OK label whose QR is exactly the original GALIA payload.
    const ok = await createPrintJob(op, { idempotencyKey: key(), kind: "ORIGINAL", reportId: fin.report.id, workstationId: ws, reprintReason: null });
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: ok.job.id } });
    const okRow = await prisma.report.findUniqueOrThrow({ where: { id: fin.report.id } });
    const qrEl = buildLayout(labelContentFromReport(okRow, false), { widthMm: 100, heightMm: 100, dpi: 203, accentMode: "UTF8" }).elements.find((e): e is QrElement => e.type === "qr")!;
    expect(qrEl.data).toBe(raw);
    expect(svgQrPath(payload)).toBe(expectedQrPath(qrMatrix(raw), qrEl.x, qrEl.y, qrEl.magnification));
    expect(texts(payload)).toEqual(expect.arrayContaining(["OK", op.username, PN, "3"]));
  });

  it("an incomplete correction prints a new NOT OK label with the updated quantities", async () => {
    const op = await makeActor();
    const admin = await makeActor("ADMIN");
    const ws = await confirmedWorkstation(admin);
    const { raw, boxId } = await nokBox(op);
    const corr = await startCorrection(op, raw);
    await accept(op, boxId, corr.leaseToken, [nextSerial()]);
    const fin = await finishBox(op, boxId, corr.leaseToken, { trigger: "GALIA_RESCAN" });
    if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
    const { job } = await createPrintJob(op, { idempotencyKey: key(), kind: "ORIGINAL", reportId: fin.report.id, workstationId: ws, reprintReason: null });
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(texts(payload)).toEqual(expect.arrayContaining(["NOT OK", "MANQUANT : 19 pièces", "1", "20", PN, op.username]));
    expect(svgQrPath(payload)).toBeNull();
    expect(payload).not.toContain("<path");
  });
});
