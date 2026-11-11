import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/server/db";
import { finalizeBox, openBox, scanItem } from "@/lib/server/services/boxes";
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
import { boxLabel, itemLabel, key, makeActor, nextSerial, openLeased, PN, resetDb } from "../support/db";

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
  const fin = await finalizeBox(actor, { boxId: box.id, leaseToken, observedAcceptedCount: accepted, incompleteReason: "Coiffes manquantes" });
  if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
  expect(fin.report).toMatchObject({ result: "NOK", acceptedQty: accepted, expectedQty: expected, kind: "INITIAL", attemptNumber: 1 });
  return { raw, boxId: box.id, serials, report: fin.report };
}

async function startCorrection(actor: ActorT, raw: string) {
  const r = await openBox(actor, { raw, startCorrection: true });
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
    expect(offer.report).toMatchObject({ id: report.id, expectedQty: 20, acceptedQty: 18, result: "NOK" });
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

  it("4–5: YES opens a new correction attempt at 18/20; two new valid covers make 20/20", async () => {
    const a = await makeActor();
    const corrector = await makeActor();
    const { raw, boxId, report } = await nokBox(a);
    const opened = await startCorrection(corrector, raw);
    expect(opened.correctionStarted).toBe(true);
    expect(opened.box).toMatchObject({ acceptedCount: 18, remaining: 2, status: "NOK" });
    expect(opened.box.activeAttempt).toMatchObject({ number: 2, kind: "CORRECTION", startedBy: corrector.username });
    expect(opened.box.previousReport?.id).toBe(report.id);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { boxId, type: "BOX_CORRECTION_OPENED" } });
    expect(event.username).toBe(corrector.username);
    expect(event.details).toMatchObject({ attemptNumber: 2, previousResult: "NOK", previousReportId: report.id, previousAcceptedQty: 18 });

    const first = await scanItem(corrector, { boxId, leaseToken: opened.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(first.box.acceptedCount).toBe(19);
    expect(first.item?.attemptNumber).toBe(2);
    const second = await scanItem(corrector, { boxId, leaseToken: opened.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(second.box).toMatchObject({ acceptedCount: 20, remaining: 0 });
    expect(await prisma.acceptedItem.count({ where: { boxId, controlAttempt: { number: 2 } } })).toBe(2);
  });

  it("6–8: same-box duplicates, other-box duplicates and wrong PN never count during a correction", async () => {
    const a = await makeActor();
    const { raw, boxId, serials } = await nokBox(a);
    const other = await openLeased(a, boxLabel(5, String(++boxSeq)));
    const foreign = nextSerial();
    await accept(a, other.box.id, other.leaseToken, [foreign]);

    const { leaseToken } = await startCorrection(a, raw);
    const sameBox = await scanItem(a, { boxId, leaseToken, raw: itemLabel(serials[3]), idempotencyKey: key() });
    expect(sameBox).toMatchObject({ outcome: "DUPLICATE_SAME_BOX", title: "Déjà scannée dans cette boîte" });
    const otherBox = await scanItem(a, { boxId, leaseToken, raw: itemLabel(foreign), idempotencyKey: key() });
    expect(otherBox).toMatchObject({ outcome: "DUPLICATE_OTHER_BOX", title: "Déjà scannée dans une autre boîte" });
    expect(otherBox.duplicate?.boxSerial).toBe(other.box.boxSerial);
    const rejectedSerial = nextSerial();
    const wrongPn = await scanItem(a, { boxId, leaseToken, raw: itemLabel(rejectedSerial, "L002815593B96AH"), idempotencyKey: key() });
    expect(wrongPn).toMatchObject({ outcome: "WRONG_PART_NUMBER", expectedPartNumber: PN, partNumber: "L002815593B96AH" });
    const malformed = await scanItem(a, { boxId, leaseToken, raw: PN, idempotencyKey: key() });
    expect(malformed.outcome).toBe("INVALID_FORMAT");
    expect(malformed.box.acceptedCount).toBe(18);

    // A rejected scan reserved nothing: that serial is accepted later with the right PN.
    const ok = await scanItem(a, { boxId, leaseToken, raw: itemLabel(rejectedSerial), idempotencyKey: key() });
    expect(ok.outcome).toBe("ACCEPTED");
    expect(ok.box.acceptedCount).toBe(19);
  });

  it("9: an incomplete correction produces another NOT OK report (19) and the box can be reopened again", async () => {
    const a = await makeActor();
    const { raw, boxId, report: first } = await nokBox(a);
    const { leaseToken } = await startCorrection(a, raw);
    await scanItem(a, { boxId, leaseToken, raw: itemLabel(nextSerial(), "L002815593B96AH"), idempotencyKey: key() });
    await accept(a, boxId, leaseToken, [nextSerial()]);

    expect(await finalizeBox(a, { boxId, leaseToken, observedAcceptedCount: 19 })).toEqual({ kind: "REASON_REQUIRED", acceptedCount: 19, expectedQty: 20 });
    const fin = await finalizeBox(a, { boxId, leaseToken, observedAcceptedCount: 19, incompleteReason: "Toujours une coiffe manquante" });
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "NOK", acceptedQty: 19, difference: -1, kind: "CORRECTION", attemptNumber: 2 });
    expect(fin.kind === "FINALIZED" && fin.report.id).not.toBe(first.id);

    const offer = await openBox(a, { raw });
    expect(offer.kind === "CORRECTION_OFFER" && offer.report.acceptedQty).toBe(19);
    const third = await startCorrection(a, raw);
    expect(third.box.activeAttempt).toMatchObject({ number: 3, kind: "CORRECTION" });
    expect(third.box.acceptedCount).toBe(19);
    expect(await prisma.report.count({ where: { boxId } })).toBe(2);
  });

  it("10 & 12: a complete correction is OK; afterwards the box is read-only and never offers a correction", async () => {
    const a = await makeActor();
    const { raw, boxId } = await nokBox(a, 3, 1);
    const { leaseToken } = await startCorrection(a, raw);
    await accept(a, boxId, leaseToken, [nextSerial(), nextSerial()]);
    const fin = await finalizeBox(a, { boxId, leaseToken, observedAcceptedCount: 3 });
    expect(fin.kind === "FINALIZED" && fin.report).toMatchObject({ result: "OK", acceptedQty: 3, kind: "CORRECTION", attemptNumber: 2, issues: [] });
    const box = await prisma.box.findUniqueOrThrow({ where: { id: boxId } });
    expect(box).toMatchObject({ status: "OK", activeAttemptId: null });

    expect((await openBox(a, { raw })).kind).toBe("FINALIZED");
    expect((await openBox(a, { raw, startCorrection: true })).kind).toBe("FINALIZED");
    expect(await prisma.controlAttempt.count({ where: { boxId } })).toBe(2);
    await expect(prisma.box.update({ where: { id: boxId }, data: { status: "NOK" } })).rejects.toThrow(/GALIA_GUARD/);
  });

  it("an OK box from the first control never enters the correction flow", async () => {
    const a = await makeActor();
    const raw = boxLabel(1, String(++boxSeq));
    const { box, leaseToken } = await openLeased(a, raw);
    await accept(a, box.id, leaseToken, [nextSerial()]);
    await finalizeBox(a, { boxId: box.id, leaseToken, observedAcceptedCount: 1 });
    expect((await openBox(a, { raw, startCorrection: true })).kind).toBe("FINALIZED");
  });

  it("13: two workstations cannot open/correct the same box simultaneously", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const { raw, boxId } = await nokBox(a);
    const [ra, rb] = await Promise.all([openBox(a, { raw, startCorrection: true }), openBox(b, { raw, startCorrection: true })]);
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

  it("14: concurrent scans during a correction cannot overflow the GALIA quantity", async () => {
    const a = await makeActor();
    const { raw, boxId } = await nokBox(a);
    const { leaseToken } = await startCorrection(a, raw);
    const results = await Promise.all(Array.from({ length: 6 }, () => scanItem(a, { boxId, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() })));
    expect(results.filter((r) => r.outcome === "ACCEPTED")).toHaveLength(2);
    expect(results.filter((r) => r.outcome === "QUANTITY_REACHED")).toHaveLength(4);
    expect(await prisma.acceptedItem.count({ where: { boxId } })).toBe(20);
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
    expect(texts(nokJobBefore.payload)).toContain("QTY FOUND: 1");
    expect(svgQrPath(nokJobBefore.payload)).toBeNull();
    expect(nokJobBefore.payload).not.toContain("<path"); // All encoded symbols in this renderer use paths.

    // While the correction is open, production printing is blocked (even a reprint of the NOT OK).
    const corr = await startCorrection(op, raw);
    await expect(getJobLabel(job.id)).rejects.toMatchObject({ code: "CORRECTION_IN_PROGRESS" });
    await expect(
      createPrintJob(op, { idempotencyKey: key(), kind: "REPRINT", reportId: nok.id, workstationId: ws, reprintReason: "Étiquette perdue" }),
    ).rejects.toMatchObject({ code: "CORRECTION_IN_PROGRESS" });

    await accept(op, boxId, corr.leaseToken, [nextSerial(), nextSerial()]);
    const fin = await finalizeBox(op, { boxId, leaseToken: corr.leaseToken, observedAcceptedCount: 3 });
    if (fin.kind !== "FINALIZED") throw new Error(fin.kind);

    // The old report and its job are byte-for-byte unchanged.
    expect(await prisma.report.findUniqueOrThrow({ where: { id: nok.id } })).toEqual(nokRowBefore);
    expect(await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(nokJobBefore);
    await expect(getJobLabel(job.id)).rejects.toMatchObject({ code: "REPORT_SUPERSEDED" });
    // An old report is never re-rendered with the newer quantity; it is simply no longer printable.
    expect(labelContentFromReport(nokRowBefore, true)).toMatchObject({ template: "NOT_OK", qtyFound: 1 });
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

  it("an incomplete correction prints a new NOT OK label with the updated QTY FOUND", async () => {
    const op = await makeActor();
    const admin = await makeActor("ADMIN");
    const ws = await confirmedWorkstation(admin);
    const { raw, boxId } = await nokBox(op);
    const corr = await startCorrection(op, raw);
    await accept(op, boxId, corr.leaseToken, [nextSerial()]);
    const fin = await finalizeBox(op, { boxId, leaseToken: corr.leaseToken, observedAcceptedCount: 19, incompleteReason: "Encore une manquante" });
    if (fin.kind !== "FINALIZED") throw new Error(fin.kind);
    const { job } = await createPrintJob(op, { idempotencyKey: key(), kind: "ORIGINAL", reportId: fin.report.id, workstationId: ws, reprintReason: null });
    const { payload } = await prisma.printJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(texts(payload)).toEqual(expect.arrayContaining(["NOT OK", "QTY FOUND: 19", PN, op.username]));
    expect(svgQrPath(payload)).toBeNull();
    expect(payload).not.toContain("<path");
  });
});
