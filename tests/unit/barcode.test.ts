import { describe, expect, it } from "vitest";
import { BARCODE_LIMITS, parseBoxLabel, parseItemLabel, parseScan, stripTransport } from "@/lib/barcode";

describe("box GALIA label", () => {
  it("parses the supplied example, removing only the P field marker", () => {
    const r = parseBoxLabel("PL002815593B96AG_Q20_S10428865");
    expect(r).toEqual({
      kind: "BOX",
      payload: "PL002815593B96AG_Q20_S10428865",
      partNumber: "L002815593B96AG",
      quantity: 20,
      boxSerial: "10428865",
    });
  });

  it("keeps the leading L of the PN and preserves leading zeros of the serial", () => {
    const r = parseBoxLabel("PL0001_Q5_S00012345");
    expect(r.kind).toBe("BOX");
    if (r.kind === "BOX") {
      expect(r.partNumber).toBe("L0001");
      expect(r.boxSerial).toBe("00012345");
    }
  });

  it("strips trailing Enter / CR / LF only", () => {
    expect(parseBoxLabel("PL002815593B96AG_Q20_S10428865\r\n").kind).toBe("BOX");
    expect(parseBoxLabel("PL002815593B96AG_Q20_S10428865\n").kind).toBe("BOX");
    expect(stripTransport("\r\nABC_S1234\r\n")).toBe("ABC_S1234");
    expect(stripTransport("  ABC_S1234\r\n")).toBe("  ABC_S1234");
  });

  it.each([
    ["PL002815593B96AG_Q0_S10428865", "QUANTITY_INVALID"],
    ["PL002815593B96AG_Q1000_S10428865", "QUANTITY_INVALID"],
    ["PL002815593B96AG_Q99999_S10428865", "QUANTITY_INVALID"],
    ["PL002815593B96AG_Q-1_S10428865", "INVALID_CHARACTERS"],
    ["PL002815593B96AG_QAB_S10428865", "MALFORMED"],
    ["PL002815593B96AG_Q20", "MALFORMED"],
    ["PL002815593B96AG_Q20_S10428865_X1", "MALFORMED"],
    ["PL002815593B96AG_Q20_S", "MALFORMED"],
    ["PL002815593B96AG_Q20_S104", "SERIAL_LENGTH"],
    ["pL002815593B96AG_Q20_S10428865", "LOWERCASE"],
    ["PL002815593B96AG Q20_S10428865", "CONTROL_OR_SPACE"],
    [" PL002815593B96AG_Q20_S10428865", "CONTROL_OR_SPACE"],
    ["PL002815593B96AG_Q20_S10428865\t", "CONTROL_OR_SPACE"],
  ])("rejects %s (%s)", (raw, code) => {
    const r = parseBoxLabel(raw);
    expect(r.kind).toBe("ERROR");
    if (r.kind === "ERROR") expect(r.code).toBe(code);
  });

  it("accepts the bounds of the quantity", () => {
    expect(parseBoxLabel(`PL0001_Q${BARCODE_LIMITS.QTY_MAX}_S12345678`).kind).toBe("BOX");
    expect(parseBoxLabel("PL0001_Q1_S12345678").kind).toBe("BOX");
  });

  it("refuses an item label where a box label is expected", () => {
    const r = parseBoxLabel("L002815593B96AG_S70166592310");
    expect(r.kind === "ERROR" && r.code).toBe("BOX_LABEL_EXPECTED");
  });
});

describe("individual seat-cover label", () => {
  it("parses the supplied example without removing the first character", () => {
    expect(parseItemLabel("L002815593B96AG_S70166592310")).toEqual({
      kind: "ITEM",
      payload: "L002815593B96AG_S70166592310",
      partNumber: "L002815593B96AG",
      serial: "70166592310",
    });
  });

  it("keeps a PN that itself starts with P", () => {
    const r = parseItemLabel("PL002815593B96AG_S70166592310");
    expect(r.kind === "ITEM" && r.partNumber).toBe("PL002815593B96AG");
  });

  it("preserves leading zeros", () => {
    const r = parseItemLabel("L002815593B96AG_S0000123");
    expect(r.kind === "ITEM" && r.serial).toBe("0000123");
  });

  it.each([
    ["L002815593B96AG", "PN_ONLY"],
    ["70166592310", "SERIAL_ONLY"],
    ["S70166592310", "SERIAL_ONLY"],
    ["L002815593B96AG_S", "MALFORMED"],
    ["L002815593B96AG_70166592310", "MALFORMED"],
    ["L002815593B96AG_S70166592310_X", "MALFORMED"],
    ["L002815593B96AG_S7016659231A", "MALFORMED"],
    ["l002815593b96ag_s70166592310", "LOWERCASE"],
    ["L002815593B96AG°S70166592310", "KEYBOARD_LAYOUT"],
    ["L&é\"'(-è_çà", "KEYBOARD_LAYOUT"],
    ["L002815593B96AG-S70166592310", "INVALID_CHARACTERS"],
    ["", "EMPTY"],
    ["\r\n", "EMPTY"],
    ["A".repeat(200), "TOO_LONG"],
  ])("rejects %j (%s)", (raw, code) => {
    const r = parseItemLabel(raw);
    expect(r.kind).toBe("ERROR");
    if (r.kind === "ERROR") expect(r.code).toBe(code);
  });

  it("refuses a box label where an item label is expected", () => {
    const r = parseItemLabel("PL002815593B96AG_Q20_S10428865");
    expect(r.kind === "ERROR" && r.code).toBe("ITEM_LABEL_EXPECTED");
  });

  it("does not hardcode the example lengths", () => {
    expect(parseItemLabel("ABC_S1234").kind).toBe("ITEM");
    expect(parseItemLabel(`${"Z".repeat(BARCODE_LIMITS.PN_MAX)}_S${"9".repeat(BARCODE_LIMITS.SERIAL_MAX)}`).kind).toBe("ITEM");
    expect(parseItemLabel(`${"Z".repeat(BARCODE_LIMITS.PN_MAX + 1)}_S1234`).kind).toBe("ERROR");
  });
});

describe("parseScan classification", () => {
  it("routes both formats", () => {
    expect(parseScan("PL002815593B96AG_Q20_S10428865").kind).toBe("BOX");
    expect(parseScan("L002815593B96AG_S70166592310").kind).toBe("ITEM");
    expect(parseScan("garbage!").kind).toBe("ERROR");
  });
});
