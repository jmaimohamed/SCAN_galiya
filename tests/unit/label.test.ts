import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { qrMatrix } from "@/lib/server/qr";
import { buildLayout, LabelLayoutError, TEST_QR_DATA, type LabelConfig, type LabelLayout, type NotOkContent, type OkContent, type QrElement, type TextElement } from "@/lib/zpl/layout";
import { renderLabel } from "@/lib/zpl/render";
import { expectedQrPath, svgQrPath, svgTexts } from "../support/label";

const GALIA = "PL002815593B96AG_Q20_S10428865";
const ok: OkContent = { template: "OK", operator: "OP042", partNumber: "L002815593B96AG", quantity: 20, boxSerial: "10428865", galiaPayload: GALIA, reprint: false };
const notOk: NotOkContent = { template: "NOT_OK", operator: "OP042", partNumber: "L002815593B96AG", qtyFound: 18, reprint: false };
const cfg = (widthMm = 100, heightMm = 100): LabelConfig => ({ widthMm, heightMm, dpi: 203, accentMode: "UTF8" });
const printOpts = (c: LabelConfig) => ({ qrMatrix, physical: { widthMm: c.widthMm, heightMm: c.heightMm } });

function texts(layout: LabelLayout): TextElement[] {
  return layout.elements.filter((e): e is TextElement => e.type === "text");
}

describe("OK label (HTML/SVG print view)", () => {
  const { svg, layout } = renderLabel(ok, cfg(), printOpts(cfg()));

  it("has a very large OK, PN, quantity, box serial and the finalizing operator", () => {
    expect(svgTexts(svg)).toEqual(expect.arrayContaining(["OK", "L002815593B96AG", "20", "10428865", "OP042"]));
    const result = texts(layout).find((t) => t.role === "result")!;
    expect(result.fontHeight).toBeGreaterThanOrEqual(10 * 8); // ≥ 10 mm high
  });

  it("draws a QR whose content is exactly the original GALIA payload", () => {
    const qr = layout.elements.find((e): e is QrElement => e.type === "qr")!;
    expect(qr.data).toBe(GALIA);
    expect(svgQrPath(svg)).toBe(expectedQrPath(qrMatrix(GALIA), qr.x, qr.y, qr.magnification));
    // The encoder received exactly the payload, nothing else (no URL, no report reference).
    const encoded = QRCode.create(GALIA, { errorCorrectionLevel: "Q" }).segments.map((s) => {
      const data = (s as { data: string | Uint8Array }).data;
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    }).join("");
    expect(encoded).toBe(GALIA);
  });

  it("is sized in physical millimetres and contains no printer command language", () => {
    expect(svg).toMatch(/^<svg[^>]* width="100mm" height="100mm"/);
    expect(svg).not.toContain("^XA");
    expect(svg).not.toContain("^FD");
  });

  it("refuses a QR payload that is not a validated GALIA string", () => {
    expect(() => renderLabel({ ...ok, galiaPayload: "https://example.com/x" }, cfg())).toThrow(LabelLayoutError);
  });
});

describe("NOT OK label", () => {
  const { svg } = renderLabel(notOk, cfg(), printOpts(cfg()));

  it("shows NOT OK, the PN, QTY FOUND and the operator — nothing else", () => {
    expect(svgTexts(svg)).toEqual(["OPÉRATEUR", "OP042", "NOT OK", "PN", "L002815593B96AG", "QTY FOUND: 18"]);
    expect(svg).not.toContain("10428865");
    expect(svg).not.toContain("VR-");
    expect(svgTexts(svg).some((t) => t === "20")).toBe(false);
  });

  it("contains no QR code or barcode", () => {
    expect(svg).not.toContain("<path");
    expect(svg).not.toMatch(/data-role="[^"]*qr/);
  });
});

describe("placement, markings and TEST label", () => {
  it("puts the finalizing operator in the top-right corner (OK and NOT OK)", () => {
    for (const content of [ok, notOk]) {
      const layout = buildLayout(content, cfg());
      const op = texts(layout).find((t) => t.role === "operator")!;
      expect(op.text).toBe("OP042");
      expect(op.align).toBe("R");
      expect(op.x + op.width).toBe(layout.widthDots - layout.marginDots);
      expect(op.y).toBeLessThan(layout.heightDots / 4);
      expect(op.x).toBeGreaterThan(layout.widthDots / 3);
    }
  });

  it("marks reprints RÉIMPRESSION and keeps the original operator top-right", () => {
    const { svg, layout } = renderLabel({ ...notOk, reprint: true }, cfg(), printOpts(cfg()));
    expect(svgTexts(svg)).toContain("RÉIMPRESSION");
    expect(texts(layout).find((t) => t.role === "operator")!.text).toBe("OP042");
  });

  it("TEST label: TEST — NE PAS UTILISER, a 50 mm scale bar, and a QR the app rejects", () => {
    const c = cfg();
    const { svg, layout } = renderLabel({ template: "TEST", operator: "ADMIN01", workstationName: "POSTE-1" }, c, printOpts(c));
    expect(svgTexts(svg).join(" ")).toContain("TEST — NE PAS UTILISER");
    expect(svgTexts(svg)).toContain("Poste : POSTE-1");
    const ruler = layout.elements.find((e) => e.role === "scale-ruler");
    expect(ruler && ruler.type === "rect" && ruler.width).toBe(50 * 8);
    expect(layout.elements.find((e): e is QrElement => e.type === "qr")!.data).toBe(TEST_QR_DATA);
  });

  it("escapes text safely in the SVG", () => {
    const { svg } = renderLabel({ ...notOk, operator: "A<B&C" }, cfg(), printOpts(cfg()));
    expect(svg).toContain("A&lt;B&amp;C");
    expect(svg).not.toContain("A<B");
  });
});

describe("layout validation for the configured stock", () => {
  it.each([
    [100, 100],
    [102, 152],
    [104, 200],
  ])("keeps every element inside the printable area of %i × %i mm", (w, h) => {
    for (const content of [ok, notOk, { ...ok, reprint: true }]) {
      const layout = buildLayout(content, cfg(w, h));
      for (const el of layout.elements) {
        const ew = el.type === "text" ? el.width : el.type === "rect" ? el.width : el.modules * el.magnification;
        const eh = el.type === "text" ? el.fontHeight : el.type === "rect" ? el.height : el.modules * el.magnification;
        expect(el.x).toBeGreaterThanOrEqual(layout.marginDots);
        expect(el.y).toBeGreaterThanOrEqual(layout.marginDots);
        expect(el.x + ew).toBeLessThanOrEqual(layout.widthDots - layout.marginDots);
        expect(el.y + eh).toBeLessThanOrEqual(layout.heightDots - layout.marginDots);
      }
    }
  });

  it("wraps or shrinks long identifiers without truncating them", () => {
    const longPn = "L".padEnd(40, "7");
    const longSerial = "1".repeat(30);
    const layout = buildLayout({ ...ok, partNumber: longPn, boxSerial: longSerial, operator: "W".repeat(32), galiaPayload: `P${longPn}_Q999_S${longSerial}` }, cfg());
    expect(texts(layout).filter((t) => t.role.startsWith("part-number") && !t.role.endsWith("caption")).map((t) => t.text).join("")).toBe(longPn);
    expect(texts(layout).filter((t) => t.role.startsWith("operator") && t.role !== "operator-caption").map((t) => t.text).join("")).toBe("W".repeat(32));
  });

  it("refuses stock too small for the content instead of clipping", () => {
    expect(() => buildLayout(ok, cfg(50, 50))).toThrow(LabelLayoutError);
  });

  it("refuses an unsupported size", () => {
    expect(() => buildLayout(ok, cfg(120, 100))).toThrow(/Largeur/);
    expect(() => buildLayout(ok, cfg(100, 20))).toThrow(/Hauteur/);
  });
});
