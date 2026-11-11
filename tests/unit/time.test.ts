import { describe, expect, it } from "vitest";
import { formatDateTime, plantDayStartUtc } from "@/lib/time";
import { reportReference } from "@/lib/labels";

describe("time zone handling (UTC storage, Africa/Tunis display)", () => {
  it("displays UTC instants in Africa/Tunis (UTC+1)", () => {
    expect(formatDateTime("2026-11-11T09:05:07.000Z")).toBe("11/11/2026 10:05:07");
  });

  it("computes plant-day boundaries in UTC", () => {
    expect(plantDayStartUtc("2026-11-11")?.toISOString()).toBe("2026-11-10T23:00:00.000Z");
    expect(plantDayStartUtc("2026-02-30")).toBeNull();
    expect(plantDayStartUtc("nope")).toBeNull();
  });

  it("formats unique report references from the sequence number", () => {
    expect(reportReference(42, "2026-11-11T09:00:00Z")).toBe("VR-2026-000042");
    expect(reportReference(42, "2026-12-31T23:30:00Z")).toBe("VR-2027-000042");
  });
});
