import { describe, expect, it } from "vitest";
import { NetworkError, isRetryable } from "@/lib/client/api";
import { ScanQueue } from "@/lib/client/scan-queue";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ordered scan queue", () => {
  it("processes rapid scans exactly once each, in arrival order, one at a time", async () => {
    const processed: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const q = new ScanQueue<string>({
      isRetryable,
      process: async (job) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick(Math.random() * 5);
        processed.push(job.raw);
        inFlight--;
        return job.raw;
      },
    });
    const raws = Array.from({ length: 40 }, (_, i) => `L002815593B96AG_S7016659${String(i).padStart(4, "0")}`);
    raws.forEach((r) => q.enqueue(r));
    await q.idle();
    expect(processed).toEqual(raws);
    expect(maxInFlight).toBe(1);
  });

  it("retries a network failure with the SAME idempotency key and keeps later scans behind it", async () => {
    const calls: { raw: string; key: string }[] = [];
    let failures = 2;
    const q = new ScanQueue<void>({
      isRetryable,
      retryDelayMs: () => 1,
      process: async (job) => {
        calls.push({ raw: job.raw, key: job.key });
        if (job.raw === "A_S1111" && failures-- > 0) throw new NetworkError();
      },
    });
    const a = q.enqueue("A_S1111");
    const b = q.enqueue("B_S2222");
    await q.idle();
    expect(calls.map((c) => c.raw)).toEqual(["A_S1111", "A_S1111", "A_S1111", "B_S2222"]);
    expect(new Set(calls.filter((c) => c.raw === "A_S1111").map((c) => c.key))).toEqual(new Set([a.key]));
    expect(calls[3].key).toBe(b.key);
    expect(a.key).not.toBe(b.key);
  });

  it("reports unconfirmed scans while retrying (never as accepted)", async () => {
    let fail = true;
    const states: string[] = [];
    const q: ScanQueue<void> = new ScanQueue<void>({
      isRetryable,
      retryDelayMs: () => 20,
      onChange: () => states.push(q.pending.map((j) => j.status).join(",")),
      process: async () => {
        if (fail) {
          fail = false;
          throw new NetworkError();
        }
      },
    });
    q.enqueue("X_S1234");
    await tick(5);
    expect(q.hasUnconfirmed).toBe(true);
    await q.idle();
    expect(states).toContain("unconfirmed");
    expect(q.size).toBe(0);
  });

  it("drops a business rejection from the queue and continues", async () => {
    const fatal: string[] = [];
    const done: string[] = [];
    const q = new ScanQueue<void>({
      isRetryable,
      onFatal: (job) => fatal.push(job.raw),
      process: async (job) => {
        if (job.raw === "bad") throw new Error("409");
        done.push(job.raw);
      },
    });
    ["a", "bad", "c"].forEach((r) => q.enqueue(r));
    await q.idle();
    expect(fatal).toEqual(["bad"]);
    expect(done).toEqual(["a", "c"]);
  });

  it("pause keeps pending scans; resume continues them in order", async () => {
    const done: string[] = [];
    const q = new ScanQueue<void>({ isRetryable, process: async (job) => void done.push(job.raw) });
    q.pause();
    ["1", "2", "3"].forEach((r) => q.enqueue(r));
    await tick(5);
    expect(done).toEqual([]);
    expect(q.size).toBe(3);
    q.resume();
    await q.idle();
    expect(done).toEqual(["1", "2", "3"]);
  });
});
