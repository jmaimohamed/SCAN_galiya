// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("one automatic print dialog per finalized attempt", () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });

  it("claims a report once; retries, duplicate events and Strict Mode re-runs get false", async () => {
    const { claimAutoPrint } = await import("@/lib/client/auto-print");
    expect(claimAutoPrint("report-1")).toBe(true);
    expect(claimAutoPrint("report-1")).toBe(false);
    expect(claimAutoPrint("report-1")).toBe(false);
    expect(claimAutoPrint("report-2")).toBe(true);
  });

  it("survives a page refresh / history navigation in the same tab", async () => {
    const first = await import("@/lib/client/auto-print");
    expect(first.claimAutoPrint("report-3")).toBe(true);
    vi.resetModules(); // a reload: fresh module memory, same sessionStorage
    const reloaded = await import("@/lib/client/auto-print");
    expect(reloaded.claimAutoPrint("report-3")).toBe(false);
  });

  it("still allows exactly one claim when sessionStorage is unavailable", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { claimAutoPrint } = await import("@/lib/client/auto-print");
    expect(claimAutoPrint("report-4")).toBe(true);
    expect(claimAutoPrint("report-4")).toBe(false);
    spy.mockRestore();
  });
});
