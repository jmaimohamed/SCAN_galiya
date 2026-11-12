import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/server/db";
import { AppError } from "@/lib/server/errors";
import { finalizeBox, getBoxSummary, openBox, scanItem, suspendBox } from "@/lib/server/services/boxes";
import { boxLabel, finishBox, itemLabel, key, makeActor, newSession, nextSerial, openLeased, PN, resetDb } from "../support/db";

let boxSeq = 10_000_000;
const nextBoxSerial = () => String(++boxSeq);

beforeEach(async () => {
  await resetDb();
});

async function fill(actor: Awaited<ReturnType<typeof makeActor>>, boxId: string, leaseToken: string, n: number) {
  const serials: string[] = [];
  for (let i = 0; i < n; i++) {
    const s = nextSerial();
    const r = await scanItem(actor, { boxId, leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(r.outcome).toBe("ACCEPTED");
    serials.push(s);
  }
  return serials;
}

describe("opening boxes", () => {
  it("creates a box from the GALIA label and never duplicates it on rescan", async () => {
    const a = await makeActor();
    const raw = boxLabel(20, nextBoxSerial());
    const first = await openBox(a, { raw: `${raw}\r\n` });
    expect(first.kind).toBe("OPENED");
    if (first.kind !== "OPENED") return;
    expect(first.created).toBe(true);
    expect(first.box).toMatchObject({ partNumber: PN, expectedQty: 20, acceptedCount: 0, remaining: 20, status: "IN_PROGRESS", galiaPayload: raw });
    expect(first.box.counts).toMatchObject({ expected: 20, distinct: 0, conforming: 0, nonconforming: 0, events: 0 });

    // Same label again from another tab of the same user: same record, ownership question.
    const tab2 = await newSession(a.userId, a.username, a.role);
    const again = await openBox(tab2, { raw });
    expect(again.kind).toBe("OWNED");
    expect(await prisma.box.count()).toBe(1);
  });

  it("blocks an existing box serial scanned with different PN or quantity", async () => {
    const a = await makeActor();
    const serial = nextBoxSerial();
    await openLeased(a, boxLabel(20, serial));
    const qty = await openBox(a, { raw: boxLabel(21, serial) });
    expect(qty.kind).toBe("CONFLICT");
    const pn = await openBox(a, { raw: boxLabel(20, serial, "L999999999") });
    expect(pn.kind).toBe("CONFLICT");
    const box = await prisma.box.findUniqueOrThrow({ where: { boxSerial: serial } });
    expect(box.expectedQty).toBe(20);
    expect(box.partNumber).toBe(PN);
  });

  it("rejects malformed GALIA labels without creating anything", async () => {
    const a = await makeActor();
    const r = await openBox(a, { raw: "PL002815593B96AG_Q0_S10428865" });
    expect(r.kind).toBe("INVALID");
    expect(await prisma.box.count()).toBe(0);
  });

  it("opens finalized boxes read-only", async () => {
    const a = await makeActor();
    const raw = boxLabel(1, nextBoxSerial());
    const { box, leaseToken } = await openLeased(a, raw);
    await fill(a, box.id, leaseToken, 1);
    await finishBox(a, box.id, leaseToken);
    const r = await openBox(a, { raw });
    expect(r.kind).toBe("FINALIZED");
  });
});

describe("cover scans (honest counting)", () => {
  it("counts a matching PN as one conforming piece, reserved only after commit", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    const r = await scanItem(a, { boxId: box.id, leaseToken, raw: "L002815593B96AG_S70166592310", idempotencyKey: key() });
    expect(r.outcome).toBe("ACCEPTED");
    expect(r.title).toBe("OK — Pièce conforme comptée");
    expect(r.item).toMatchObject({ serial: "70166592310", partNumber: PN, acceptedBy: a.username });
    expect(r.box.acceptedCount).toBe(1);
    expect(r.box.counts).toMatchObject({ distinct: 1, conforming: 1, nonconforming: 0, reserved: 1, events: 1 });
    expect(await prisma.acceptedItem.count({ where: { boxId: box.id } })).toBe(1);
  });

  it("records a different PN as a nonconforming observation without reserving the serial", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    const s = nextSerial();
    const r = await scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(s, "L002815593B96AH"), idempotencyKey: key() });
    expect(r.outcome).toBe("WRONG_PART_NUMBER");
    expect(r.title).toBe("RÉFÉRENCE DIFFÉRENTE — pièce non conforme");
    expect(r.expectedPartNumber).toBe(PN);
    expect(r.partNumber).toBe("L002815593B96AH");
    expect(r.box.acceptedCount).toBe(0);
    expect(r.box.counts).toMatchObject({ distinct: 1, conforming: 0, nonconforming: 1, wrongPartNumber: 1 });
    expect(await prisma.acceptedItem.count()).toBe(0);
    expect(await prisma.activeSerialReservation.count()).toBe(0);
  });

  it("records malformed scans as invalid attempts that never change the quantity", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    let last = null;
    for (const raw of ["L002815593B96AG", "70166592310", "L002815593B96AG_S", "junk<script>"]) {
      last = await scanItem(a, { boxId: box.id, leaseToken, raw, idempotencyKey: key() });
      expect(last.outcome).toBe("INVALID_FORMAT");
      expect(last.title).toBe("FORMAT INVALIDE — non compté");
    }
    expect(last!.box.counts).toMatchObject({ distinct: 0, invalid: 4, events: 4 });
    expect(await prisma.acceptedItem.count()).toBe(0);
    expect(await prisma.scanAttempt.count({ where: { outcome: "INVALID_FORMAT" } })).toBe(4);
  });

  it("records a second scan of the same cover as a duplicate attempt (quantity unchanged)", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    const [s] = await fill(a, box.id, leaseToken, 1);
    const r = await scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(r.outcome).toBe("DUPLICATE_SAME_BOX");
    expect(r.title).toBe("SCAN EN DOUBLE — déjà compté");
    expect(r.box.acceptedCount).toBe(1);
    expect(r.box.counts).toMatchObject({ distinct: 1, conforming: 1, duplicates: 1 });
  });

  it("records a repeated nonconforming cover as a duplicate, not as a second piece", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(5, nextBoxSerial()));
    const s = nextSerial();
    await scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(s, "LOTHERPN1"), idempotencyKey: key() });
    const again = await scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(s, "LOTHERPN1"), idempotencyKey: key() });
    expect(again.outcome).toBe("DUPLICATE_SAME_BOX");
    expect(again.box.counts).toMatchObject({ distinct: 1, nonconforming: 1, wrongPartNumber: 1, duplicates: 1 });
  });

  it("records a serial of another box as nonconforming, and the other box keeps it", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const first = await openLeased(a, boxLabel(20, nextBoxSerial()));
    const [s] = await fill(a, first.box.id, first.leaseToken, 1);
    const second = await openLeased(b, boxLabel(20, nextBoxSerial()));
    const r = await scanItem(b, { boxId: second.box.id, leaseToken: second.leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(r.outcome).toBe("DUPLICATE_OTHER_BOX");
    expect(r.title).toBe("SÉRIE DÉJÀ UTILISÉE dans une autre boîte");
    expect(r.duplicate).toMatchObject({ boxSerial: first.box.boxSerial, acceptedBy: a.username });
    expect(r.duplicate?.acceptedAt).toMatch(/^\d{4}-/);
    expect(r.box.acceptedCount).toBe(0);
    expect(r.box.counts).toMatchObject({ distinct: 1, nonconforming: 1, otherBox: 1 });
    expect(await prisma.activeSerialReservation.findUniqueOrThrow({ where: { serial: s } })).toMatchObject({ boxId: first.box.id });
  });

  it("records matching covers beyond the GALIA quantity as excess, never reserved", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(2, nextBoxSerial()));
    await fill(a, box.id, leaseToken, 2);
    const s = nextSerial();
    const r = await scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(r.outcome).toBe("EXCESS");
    expect(r.title).toBe("DÉPASSEMENT — pièce en excédent");
    expect(r.box.counts).toMatchObject({ expected: 2, distinct: 3, conforming: 3, excess: 1, extra: 1, reserved: 2 });
    expect(await prisma.acceptedItem.count({ where: { boxId: box.id } })).toBe(2);
    expect(await prisma.activeSerialReservation.findUnique({ where: { serial: s } })).toBeNull();
    // The control stays open: reaching or exceeding the quantity never finalizes anything.
    expect(await getBoxSummary(box.id)).toMatchObject({ status: "IN_PROGRESS", latestReport: null });
  });

  it("does not reserve excess or wrong-PN serials: the same serial is accepted later in a correct box", async () => {
    const a = await makeActor();
    const full = await openLeased(a, boxLabel(1, nextBoxSerial()));
    await fill(a, full.box.id, full.leaseToken, 1);
    const s = nextSerial();
    const excess = await scanItem(a, { boxId: full.box.id, leaseToken: full.leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(excess.outcome).toBe("EXCESS");
    const wrongPn = await openLeased(a, boxLabel(5, nextBoxSerial(), "L000000000X1"));
    const rejected2 = await scanItem(a, { boxId: wrongPn.box.id, leaseToken: wrongPn.leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(rejected2.outcome).toBe("WRONG_PART_NUMBER");

    const good = await openLeased(a, boxLabel(5, nextBoxSerial()));
    const accepted = await scanItem(a, { boxId: good.box.id, leaseToken: good.leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(accepted.outcome).toBe("ACCEPTED");
  });

  it("keeps serials of a NOK box reserved", async () => {
    const a = await makeActor();
    const nok = await openLeased(a, boxLabel(3, nextBoxSerial()));
    const [s] = await fill(a, nok.box.id, nok.leaseToken, 1);
    const fin = await finishBox(a, nok.box.id, nok.leaseToken);
    expect(fin.kind === "FINALIZED" && fin.report.result).toBe("NOK");
    const other = await openLeased(a, boxLabel(3, nextBoxSerial()));
    const r = await scanItem(a, { boxId: other.box.id, leaseToken: other.leaseToken, raw: itemLabel(s), idempotencyKey: key() });
    expect(r.outcome).toBe("DUPLICATE_OTHER_BOX");
  });
});

describe("idempotency", () => {
  it("returns the original result for an exact retry and never double counts", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    const k = key();
    const raw = itemLabel(nextSerial());
    const first = await scanItem(a, { boxId: box.id, leaseToken, raw, idempotencyKey: k });
    const retry = await scanItem(a, { boxId: box.id, leaseToken, raw, idempotencyKey: k });
    expect(first.outcome).toBe("ACCEPTED");
    expect(retry.outcome).toBe("ACCEPTED");
    expect(retry.attemptId).toBe(first.attemptId);
    expect(retry.replayed).toBe(true);
    expect(retry.box.acceptedCount).toBe(1);
    expect(retry.box.counts).toMatchObject({ distinct: 1, duplicates: 0, events: 1 });
    expect(await prisma.scanAttempt.count()).toBe(1);
  });

  it("handles concurrent retries of the same key as one logical scan", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    const k = key();
    const raw = itemLabel(nextSerial());
    const results = await Promise.all(Array.from({ length: 6 }, () => scanItem(a, { boxId: box.id, leaseToken, raw, idempotencyKey: k })));
    expect(new Set(results.map((r) => r.attemptId)).size).toBe(1);
    expect(results.every((r) => r.outcome === "ACCEPTED")).toBe(true);
    expect(await prisma.acceptedItem.count()).toBe(1);
  });

  it("rejects reuse of a key with another payload", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    const k = key();
    await scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: k });
    await expect(scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: k })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      status: 409,
    });
    expect(await prisma.acceptedItem.count()).toBe(1);
  });
});

describe("concurrency (PostgreSQL row locks + unique constraints)", () => {
  it("accepts the same item exactly once when two workstations scan it simultaneously", async () => {
    const a = await makeActor();
    const b = await makeActor();
    for (let round = 0; round < 5; round++) {
      const boxA = await openLeased(a, boxLabel(20, nextBoxSerial()));
      const boxB = await openLeased(b, boxLabel(20, nextBoxSerial()));
      const s = nextSerial();
      const [ra, rb] = await Promise.all([
        scanItem(a, { boxId: boxA.box.id, leaseToken: boxA.leaseToken, raw: itemLabel(s), idempotencyKey: key() }),
        scanItem(b, { boxId: boxB.box.id, leaseToken: boxB.leaseToken, raw: itemLabel(s), idempotencyKey: key() }),
      ]);
      const outcomes = [ra.outcome, rb.outcome].sort();
      expect(outcomes).toEqual(["ACCEPTED", "DUPLICATE_OTHER_BOX"]);
      expect(await prisma.acceptedItem.count({ where: { serial: s } })).toBe(1);
    }
  });

  it("never reserves beyond the quantity when several scans race at 19/20: the others are recorded excess", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    await fill(a, box.id, leaseToken, 19);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() })),
    );
    expect(results.filter((r) => r.outcome === "ACCEPTED")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "EXCESS")).toHaveLength(5);
    expect(await prisma.acceptedItem.count({ where: { boxId: box.id } })).toBe(20);
    expect((await getBoxSummary(box.id)).counts).toMatchObject({ distinct: 25, conforming: 25, excess: 5, extra: 5, reserved: 20 });
  });

  it("keeps finalization consistent when it races with a scan (the scan is never silently ignored)", async () => {
    const a = await makeActor();
    for (let round = 0; round < 8; round++) {
      const { box, leaseToken } = await openLeased(a, boxLabel(5, nextBoxSerial()));
      await fill(a, box.id, leaseToken, 4);
      const seen = await getBoxSummary(box.id);
      const [fin, scan] = await Promise.all([
        finalizeBox(a, { boxId: box.id, leaseToken, attemptId: seen.activeAttempt!.id, trigger: "GALIA_RESCAN", galiaRaw: seen.galiaPayload, observed: { events: seen.counts.events, reserved: seen.counts.reserved } }),
        scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() }),
      ]);
      const saved = await prisma.box.findUniqueOrThrow({ where: { id: box.id }, include: { reports: true, _count: { select: { items: true } } } });
      if (fin.kind === "FINALIZED") {
        // Finalize won the lock: the scan is recorded as arriving after the end, and the report matches the stored items.
        expect(scan.outcome).toBe("BOX_NOT_IN_PROGRESS");
        expect(await prisma.scanAttempt.count({ where: { boxId: box.id, outcome: "BOX_NOT_IN_PROGRESS" } })).toBe(1);
        expect(saved.reports).toHaveLength(1);
        expect(saved.reports[0]).toMatchObject({ acceptedQty: 4, missingQty: 1, result: "NOK" });
        expect(saved._count.items).toBe(4);
        expect(saved.status).toBe("NOK");
      } else {
        // The scan won: the end request saw other counts and changed nothing.
        expect(fin.kind).toBe("STATE_CHANGED");
        expect(scan.outcome).toBe("ACCEPTED");
        expect(saved.status).toBe("IN_PROGRESS");
        expect(saved.reports).toHaveLength(0);
        expect(saved._count.items).toBe(5);
      }
    }
  });
});

describe("ownership and authorization", () => {
  it("refuses writes from a session that does not hold the lease", async () => {
    const owner = await makeActor();
    const intruder = await makeActor();
    const { box, leaseToken } = await openLeased(owner, boxLabel(20, nextBoxSerial()));

    const stolenToken = await scanItem(intruder, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(stolenToken.outcome).toBe("NOT_BOX_OWNER");
    const bogus = await scanItem(intruder, { boxId: box.id, leaseToken: "x".repeat(43), raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(bogus.outcome).toBe("NOT_BOX_OWNER");
    await expect(finishBox(intruder, box.id, leaseToken)).rejects.toMatchObject({ code: "NOT_BOX_OWNER" });
    await expect(suspendBox(intruder, { boxId: box.id, leaseToken })).rejects.toBeInstanceOf(AppError);
    expect(await prisma.acceptedItem.count()).toBe(0);
    // Lease refusals are not part of the control's tally.
    expect((await getBoxSummary(box.id)).counts.events).toBe(0);
  });

  it("allows an audited handover; the previous tab/workstation can no longer write", async () => {
    const a = await makeActor();
    const b = await makeActor();
    const raw = boxLabel(20, nextBoxSerial());
    const first = await openLeased(a, raw);
    const asked = await openBox(b, { raw });
    expect(asked.kind).toBe("OWNED");
    if (asked.kind === "OWNED") expect(asked.owner.username).toBe(a.username);
    const taken = await openBox(b, { raw, takeover: true });
    expect(taken.kind).toBe("OPENED");
    if (taken.kind !== "OPENED") return;
    expect(taken.tookOverFrom).toBe(a.username);

    const old = await scanItem(a, { boxId: first.box.id, leaseToken: first.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(old.outcome).toBe("NOT_BOX_OWNER");
    const fresh = await scanItem(b, { boxId: taken.box.id, leaseToken: taken.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(fresh.outcome).toBe("ACCEPTED");
    const events = await prisma.auditEvent.findMany({ where: { boxId: first.box.id, type: "BOX_TAKEOVER" } });
    expect(events).toHaveLength(1);
    expect(events[0].username).toBe(b.username);
  });

  it("two tabs of the same user cannot both write", async () => {
    const a = await makeActor();
    const tab2 = await newSession(a.userId, a.username, a.role);
    const raw = boxLabel(20, nextBoxSerial());
    const t1 = await openLeased(a, raw);
    const t2 = await openBox(tab2, { raw, takeover: true });
    if (t2.kind !== "OPENED") throw new Error("expected OPENED");
    const r1 = await scanItem(a, { boxId: t1.box.id, leaseToken: t1.leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(r1.outcome).toBe("NOT_BOX_OWNER");
  });

  it("suspends a box and lets it be resumed without a handover", async () => {
    const a = await makeActor();
    const raw = boxLabel(20, nextBoxSerial());
    const { box, leaseToken } = await openLeased(a, raw);
    await suspendBox(a, { boxId: box.id, leaseToken });
    const b = await makeActor();
    const resumed = await openBox(b, { raw });
    expect(resumed.kind).toBe("OPENED");
  });
});

describe("finalization", () => {
  it("ends an incomplete box NOT OK with the missing quantity (no reason required; optional note kept)", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(20, nextBoxSerial()));
    await fill(a, box.id, leaseToken, 18);
    const done = await finishBox(a, box.id, leaseToken, { note: "  Rupture de coiffes  " });
    expect(done.kind).toBe("FINALIZED");
    if (done.kind !== "FINALIZED") return;
    expect(done.report).toMatchObject({ result: "NOK", acceptedQty: 18, expectedQty: 20, difference: -2, issues: ["MISSING"], reason: "Rupture de coiffes", finalizedBy: a.username, countingVersion: 2, endTrigger: "MANUAL" });
    expect(done.report.counts).toMatchObject({ distinct: 18, conforming: 18, nonconforming: 0, missing: 2, extra: 0 });
    expect(done.report.lines).toEqual(["MANQUANT : 2 pièces"]);
    expect(done.report.reference).toMatch(/^VR-\d{4}-\d{6}$/);
  });

  it("saves OK only when every rule passes; any recorded mistake makes it NOT OK", async () => {
    const a = await makeActor();
    const clean = await openLeased(a, boxLabel(3, nextBoxSerial()));
    await fill(a, clean.box.id, clean.leaseToken, 3);
    const ok = await finishBox(a, clean.box.id, clean.leaseToken, { trigger: "GALIA_RESCAN", note: "ignored for OK" });
    expect(ok.kind === "FINALIZED" && ok.report).toMatchObject({ result: "OK", acceptedQty: 3, difference: 0, issues: [], reason: null, endTrigger: "GALIA_RESCAN", lines: ["CONFORME — Quantité et références vérifiées"] });

    const dirty = await openLeased(a, boxLabel(3, nextBoxSerial()));
    await fill(a, dirty.box.id, dirty.leaseToken, 3);
    await scanItem(a, { boxId: dirty.box.id, leaseToken: dirty.leaseToken, raw: itemLabel(nextSerial(), "WRONGPN1"), idempotencyKey: key() });
    const nok = await finishBox(a, dirty.box.id, dirty.leaseToken, { trigger: "GALIA_RESCAN" });
    expect(nok.kind === "FINALIZED" && nok.report).toMatchObject({ result: "NOK", acceptedQty: 3, issues: ["EXCESS", "WRONG_PART_NUMBER"] });
  });

  it("refuses to finalize when the operator saw different counts", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(3, nextBoxSerial()));
    await fill(a, box.id, leaseToken, 2);
    const s = await getBoxSummary(box.id);
    const r = await finalizeBox(a, { boxId: box.id, leaseToken, attemptId: s.activeAttempt!.id, trigger: "MANUAL", observed: { events: 1, reserved: 1 } });
    expect(r.kind).toBe("STATE_CHANGED");
    if (r.kind === "STATE_CHANGED") expect(r.counts).toMatchObject({ events: 2, reserved: 2 });
    expect((await getBoxSummary(box.id)).activeAttempt).not.toBeNull();
  });

  it("only the exact GALIA payload of the box ends it by rescan", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(1, nextBoxSerial()));
    await fill(a, box.id, leaseToken, 1);
    const other = await finishBox(a, box.id, leaseToken, { trigger: "GALIA_RESCAN", galiaRaw: boxLabel(1, nextBoxSerial()) });
    expect(other).toMatchObject({ kind: "GALIA_MISMATCH", scanned: { partNumber: PN, quantity: 1 } });
    const leadingZero = await finishBox(a, box.id, leaseToken, { trigger: "GALIA_RESCAN", galiaRaw: box.galiaPayload.replace("_Q1_", "_Q01_") });
    expect(leadingZero.kind).toBe("GALIA_MISMATCH");
    expect(await prisma.report.count()).toBe(0);
    expect((await finishBox(a, box.id, leaseToken, { trigger: "GALIA_RESCAN" })).kind).toBe("FINALIZED");
  });

  it("makes finalized records immutable (service and database); a retried end returns the same report", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(1, nextBoxSerial()));
    const [s] = await fill(a, box.id, leaseToken, 1);
    const seen = await getBoxSummary(box.id);
    const input = { boxId: box.id, leaseToken, attemptId: seen.activeAttempt!.id, trigger: "GALIA_RESCAN" as const, galiaRaw: seen.galiaPayload, observed: { events: 1, reserved: 1 } };
    const done = await finalizeBox(a, input);
    expect(done.kind).toBe("FINALIZED");

    const after = await scanItem(a, { boxId: box.id, leaseToken, raw: itemLabel(nextSerial()), idempotencyKey: key() });
    expect(after.outcome).toBe("BOX_NOT_IN_PROGRESS");
    const retry = await finalizeBox(a, input);
    expect(retry.kind).toBe("ALREADY_FINALIZED");
    if (retry.kind === "ALREADY_FINALIZED" && done.kind === "FINALIZED") expect(retry.report.id).toBe(done.report.id);
    expect(await prisma.report.count()).toBe(1);

    // Direct database writes are refused by the guards.
    await expect(prisma.box.update({ where: { id: box.id }, data: { status: "NOK" } })).rejects.toThrow(/GALIA_GUARD/);
    await expect(prisma.report.updateMany({ where: { boxId: box.id }, data: { acceptedQty: 99 } })).rejects.toThrow(/GALIA_GUARD/);
    await expect(prisma.acceptedItem.deleteMany({ where: { serial: s } })).rejects.toThrow(/GALIA_GUARD/);
    await expect(prisma.scanAttempt.deleteMany({})).rejects.toThrow(/GALIA_GUARD/);
    await expect(prisma.auditEvent.deleteMany({})).rejects.toThrow(/GALIA_GUARD/);
  });

  it("database guard refuses an over-quantity insert even outside the service", async () => {
    const a = await makeActor();
    const { box, leaseToken } = await openLeased(a, boxLabel(1, nextBoxSerial()));
    await fill(a, box.id, leaseToken, 1);
    const attempt = await prisma.scanAttempt.findFirstOrThrow();
    const { activeAttemptId } = await prisma.box.findUniqueOrThrow({ where: { id: box.id } });
    await expect(
      prisma.acceptedItem.create({
        data: { serial: nextSerial(), partNumber: PN, rawPayload: "x", boxId: box.id, controlAttemptId: activeAttemptId!, acceptedById: a.userId, attemptId: attempt.id },
      }),
    ).rejects.toThrow(/GALIA_GUARD/);
    expect(await prisma.acceptedItem.count({ where: { boxId: box.id } })).toBe(1);
  });
});
