import { afterEach, describe, expect, it, vi } from "vitest";
import { clientUuid } from "@/lib/client/uuid";
import { ScanQueue } from "@/lib/client/scan-queue";

afterEach(() => vi.unstubAllGlobals());
describe("LAN HTTP client identifiers", () => {
  it("uses the native UUID API when available", () => {
    const native = vi.fn(() => "c27113bb-7000-4bee-8877-a11122223333");
    vi.stubGlobal("crypto", { randomUUID: native });
    expect(clientUuid()).toBe("c27113bb-7000-4bee-8877-a11122223333");
    expect(native).toHaveBeenCalledOnce();
  });
  it("uses cryptographic random bytes with valid version/variant bits on LAN HTTP", () => {
    const rng = vi.fn((bytes: Uint8Array) => { bytes.fill(0xff); return bytes; });
    vi.stubGlobal("crypto", { getRandomValues: rng });
    expect(clientUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(rng).toHaveBeenCalledOnce();
  });
  it("can enqueue scans without randomUUID and keeps separate idempotency keys", async () => {
    const rng = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues: rng });
    const queue = new ScanQueue({ process: async () => undefined, isRetryable: () => false });
    const a = queue.enqueue("L001_S1234");
    const b = queue.enqueue("L001_S1235");
    expect(a.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.key).not.toBe(b.key);
    await queue.idle();
  });
});
