import { describe, expect, it } from "vitest";
import { decideGaliaScan, DuplicateEventFilter, DUPLICATE_EVENT_WINDOW_MS, GALIA_ECHO_GUARD_MS, type ActiveControlRef } from "@/lib/client/scan-guards";
import { ScanQueue, type ScanJob } from "@/lib/client/scan-queue";
import { parseScan } from "@/lib/barcode";

const GALIA = "PL002815593B96AG_Q5_S10428865";
const OTHER = "PL002815593B96AG_Q5_S10428866";
const label = (payload: string) => {
  const p = parseScan(payload);
  if (p.kind !== "BOX") throw new Error("not a GALIA");
  return p;
};
const active = (over: Partial<ActiveControlRef> = {}): ActiveControlRef => ({ galiaPayload: GALIA, boxSerial: "10428865", openedAt: 10_000, openedByScan: true, lost: false, ...over });

describe("GALIA scans while a control is open", () => {
  it("the exact same GALIA ends the control", () => {
    expect(decideGaliaScan(active(), label(GALIA), 10_000 + GALIA_ECHO_GUARD_MS + 1, null)).toBe("END");
  });

  it("a duplicated opening event never immediately closes the newly opened box", () => {
    expect(decideGaliaScan(active(), label(GALIA), 10_000 + 150, null)).toBe("ECHO_AFTER_OPEN");
    expect(decideGaliaScan(active(), label(GALIA), 10_000 + GALIA_ECHO_GUARD_MS - 1, null)).toBe("ECHO_AFTER_OPEN");
    // An intentional later rescan still ends it.
    expect(decideGaliaScan(active(), label(GALIA), 10_000 + GALIA_ECHO_GUARD_MS, null)).toBe("END");
  });

  it("a control resumed by a button has no opening echo to ignore", () => {
    expect(decideGaliaScan(active({ openedByScan: false, openedAt: 0 }), label(GALIA), 5, null)).toBe("END");
  });

  it("a different box's GALIA neither ends nor switches silently (explicit choice)", () => {
    expect(decideGaliaScan(active(), label(OTHER), 60_000, null)).toBe("OTHER_BOX");
  });

  it("the same box serial with a different payload never ends the control", () => {
    expect(decideGaliaScan(active(), label("PL002815593B96AG_Q05_S10428865"), 60_000, null)).toBe("SAME_BOX_OTHER_PAYLOAD");
  });

  it("right after the end, an echo of the same GALIA is ignored; later it opens/offers normally", () => {
    const end = { payload: GALIA, at: 50_000 };
    expect(decideGaliaScan(null, label(GALIA), 50_400, end)).toBe("ECHO_AFTER_END");
    expect(decideGaliaScan(null, label(GALIA), 50_000 + GALIA_ECHO_GUARD_MS, end)).toBe("OPEN");
    expect(decideGaliaScan(null, label(OTHER), 50_400, end)).toBe("OPEN");
  });
});

describe("duplicate input events", () => {
  it("suppresses one trigger delivered twice, not a deliberate second scan", () => {
    const f = new DuplicateEventFilter();
    expect(f.accept("L1_S1234", 1000)).toBe(true);
    expect(f.accept("L1_S1234", 1000 + DUPLICATE_EVENT_WINDOW_MS - 1)).toBe(false);
    expect(f.accept("L1_S1234", 1000 + DUPLICATE_EVENT_WINDOW_MS - 1 + DUPLICATE_EVENT_WINDOW_MS)).toBe(true);
    expect(f.accept("L1_S9999", 5000)).toBe(true);
    expect(f.accept("L1_S1234", 5100)).toBe(true); // something else in between: a real new scan
  });
});

describe("ending waits for queued scans", () => {
  it("the GALIA rescan is processed only after every cover scanned before it has its answer", async () => {
    const order: string[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const queue = new ScanQueue<void>({
      isRetryable: () => false,
      process: async (job: ScanJob<void>) => {
        if (job.raw === "COVER-1") await slow;
        order.push(job.raw);
      },
    });
    queue.enqueue("COVER-1");
    queue.enqueue("COVER-2");
    queue.enqueue(GALIA);
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await queue.idle();
    expect(order).toEqual(["COVER-1", "COVER-2", GALIA]);
  });

  it("stamps each scan with its receive time (used by the echo guard)", () => {
    let t = 42;
    const queue = new ScanQueue<void>({ isRetryable: () => false, process: async () => undefined, now: () => t });
    queue.pause();
    queue.enqueue("A");
    t = 99;
    queue.enqueue("B");
    expect(queue.pending.map((j) => j.receivedAt)).toEqual([42, 99]);
  });
});
