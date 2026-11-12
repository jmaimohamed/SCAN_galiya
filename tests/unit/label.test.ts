import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { qrMatrix } from "@/lib/server/qr";
import {
  buildLayout,
  estimateTextWidth,
  LabelLayoutError,
  labelFrame,
  MARGIN_MM,
  TEMPLATE_VERSION,
  TEST_QR_DATA,
  testRulerMm,
  worstCaseContents,
  type LabelConfig,
  type LabelLayout,
  type LayoutElement,
  type NotOkContent,
  type OkContent,
  type QrElement,
  type TextElement,
} from "@/lib/zpl/layout";
import { renderLabel, renderSvg } from "@/lib/zpl/render";
import { expectedQrPath, svgQrPath, svgTextByRole, svgTexts } from "../support/label";

const GALIA = "PL002815593B96AG_Q20_S10428865";
const conforme = { expected: 20, distinct: 20, conforming: 20, nonconforming: 0, lines: ["CONFORME — Quantité et références vérifiées"] };
const ok: OkContent = { template: "OK", operator: "OP042", partNumber: "L002815593B96AG", boxSerial: "10428865", galiaPayload: GALIA, figures: conforme, finalizedAt: "12/11/2026 14:32:05", reprint: false };
const notOk: NotOkContent = {
  template: "NOT_OK",
  operator: "OP042",
  partNumber: "L002815593B96AG",
  boxSerial: "10428865",
  figures: { expected: 5, distinct: 7, conforming: 6, nonconforming: 1, lines: ["EXCÉDENT : 2 pièces", "RÉFÉRENCE DIFFÉRENTE : 1 pièce", "SCAN EN DOUBLE : 1 tentative"] },
  finalizedAt: "12/11/2026 14:32:05",
  reprint: false,
};
/** The plant stock: roll 110 mm wide, labels 210 mm long, read held horizontally. */
const cfg = (widthMm = 110, heightMm = 210, orientation: LabelConfig["orientation"] = "LANDSCAPE"): LabelConfig => ({ widthMm, heightMm, dpi: 203, accentMode: "UTF8", orientation });
const printOpts = (c: LabelConfig) => {
  const l = buildLayout(ok, c);
  return { qrMatrix, physical: { widthMm: l.frame.pageWidthMm, heightMm: l.frame.pageHeightMm } };
};

function texts(layout: LabelLayout): TextElement[] {
  return layout.elements.filter((e): e is TextElement => e.type === "text");
}

function bounds(el: LayoutElement) {
  if (el.type === "text") return { x: el.x, y: el.y, w: el.width, h: el.fontHeight };
  if (el.type === "rect") return { x: el.x, y: el.y, w: el.width, h: el.height };
  if (el.type === "qr") return { x: el.x - el.quietZone, y: el.y - el.quietZone, w: el.modules * el.magnification + 2 * el.quietZone, h: el.modules * el.magnification + 2 * el.quietZone };
  const xs = el.points.map((p) => p[0]);
  const ys = el.points.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Lowest point used by the content above the footer (dots). */
function contentBottom(layout: LabelLayout): number {
  return Math.max(...layout.elements.filter((e) => !e.role.startsWith("finalized-at") && !e.role.startsWith("reprint")).map((e) => bounds(e).y + bounds(e).h));
}

describe("OK label on the plant stock (110 × 210 mm, landscape page turned by the driver)", () => {
  const c = cfg();
  const { svg, layout } = renderLabel(ok, c, printOpts(c));

  it("is a landscape page of exactly 210 × 110 mm with no rotation in the SVG (the driver turns it once)", () => {
    expect(svg).toMatch(/^<svg[^>]* viewBox="0 0 1680 880" width="210mm" height="110mm"/);
    expect(svg).not.toContain("rotate(");
    expect(layout.frame).toMatchObject({ orientation: "LANDSCAPE", rotation: 0, pageWidthMm: 210, pageHeightMm: 110, readingWidthMm: 210, readingHeightMm: 110 });
    expect(TEMPLATE_VERSION).toBe("galia-label-v7-width");
  });

  it("fills the label: content reaches the footer, with large text", () => {
    const footerTop = Math.min(...texts(layout).filter((t) => t.role.startsWith("finalized-at")).map((t) => t.y));
    expect(footerTop - contentBottom(layout)).toBeLessThan(6 * 8); // less than 6 mm left unused
    const size = (role: string) => texts(layout).find((t) => t.role === role)!.fontHeight / 8;
    expect(size("result")).toBeGreaterThanOrEqual(25);
    expect(size("part-number")).toBeGreaterThanOrEqual(10);
    expect(size("box-serial")).toBeGreaterThanOrEqual(13);
    expect(size("figure-expected")).toBeGreaterThanOrEqual(16);
    expect(size("issue-1")).toBeGreaterThanOrEqual(6);
  });

  it("keeps every element inside the 104 mm printed band of the 110 mm roll", () => {
    const band = (3 + MARGIN_MM) * 8; // 3 mm overhang plus registration safety
    for (const el of layout.elements) {
      expect(bounds(el).y).toBeGreaterThanOrEqual(band);
      expect(bounds(el).y + bounds(el).h).toBeLessThanOrEqual(layout.heightDots - band);
    }
  });

  it("shows OK, operator, PN, box serial, quantities, explanation and finalization time", () => {
    expect(svgTexts(svg)).toEqual(expect.arrayContaining(["OK", "OP042", "L002815593B96AG", "10428865", "20", "CONFORME — Quantité et références vérifiées", "ATTENDU", "SCANNÉ", "CONFORME", "NON CONFORME", "0"]));
    expect(svgTexts(svg).join(" ")).toContain("12/11/2026 14:32:05");
  });

  it("draws a QR whose content is exactly the original GALIA payload (no URL, no reference)", () => {
    const qr = layout.elements.find((e): e is QrElement => e.type === "qr")!;
    expect(qr.data).toBe(GALIA);
    expect(svgQrPath(svg)).toBe(expectedQrPath(qrMatrix(GALIA), qr.x, qr.y, qr.magnification));
    const encoded = QRCode.create(GALIA, { errorCorrectionLevel: "Q" })
      .segments.map((s) => {
        const data = (s as { data: string | Uint8Array }).data;
        return typeof data === "string" ? data : new TextDecoder().decode(data);
      })
      .join("");
    expect(encoded).toBe(GALIA);
    expect(Number.isInteger(qr.magnification)).toBe(true);
    expect(qr.magnification).toBeGreaterThanOrEqual(6); // ≥ 0.75 mm modules on this stock
    expect(qr.quietZone).toBe(4 * qr.magnification);
  });

  it("refuses a QR payload that is not a validated GALIA string", () => {
    expect(() => renderLabel({ ...ok, galiaPayload: "https://example.com/x" }, cfg())).toThrow(LabelLayoutError);
  });
});

describe("NOT OK label", () => {
  const c = cfg();
  const { svg, layout } = renderLabel(notOk, c, printOpts(c));

  it("shows NOT OK, operator, PN, box serial, quantities and every issue line at one size", () => {
    expect(svgTexts(svg)).toEqual(expect.arrayContaining(["NOT OK", "OP042", "L002815593B96AG", "10428865", "EXCÉDENT : 2 pièces", "RÉFÉRENCE DIFFÉRENTE : 1 pièce", "SCAN EN DOUBLE : 1 tentative"]));
    expect(svgTextByRole(svg, "figure-expected")).toBe("5");
    expect(svgTextByRole(svg, "figure-scanned")).toBe("7");
    expect(svgTextByRole(svg, "figure-conforming")).toBe("6");
    expect(svgTextByRole(svg, "figure-nonconforming")).toBe("1");
    const sizes = new Set(texts(layout).filter((t) => t.role.startsWith("issue-")).map((t) => t.fontHeight));
    expect(sizes.size).toBe(1);
  });

  it("contains no QR code or barcode, and lists no individual cover serial", () => {
    expect(svg).not.toContain("<path");
    expect(svg).not.toMatch(/data-role="[^"]*qr/);
    expect(svg).not.toContain("_S");
  });
});

describe("text, placement, markings and TEST label", () => {
  it("measures text with Arial Bold widths (narrow digits, wide W), so glyphs keep their shape", () => {
    expect(estimateTextWidth("1111", 100)).toBeLessThan(estimateTextWidth("WWWW", 100));
    expect(estimateTextWidth("0123456789", 1000)).toBe(Math.ceil(5560 * 1.02));
  });

  it("puts the finalizing operator in the top-right corner of the reading frame (OK and NOT OK)", () => {
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

  it("TEST label: TEST — NE PAS UTILISER, HAUT arrow, guides in the printed band, 50 mm bar, sample text and a QR the app rejects", () => {
    const c = cfg();
    const { svg, layout } = renderLabel({ template: "TEST", operator: "ADMIN01", workstationName: "POSTE-1" }, c, printOpts(c));
    const all = svgTexts(svg).join(" ");
    expect(all).toContain("TEST — NE PAS UTILISER");
    expect(all).toContain("HAUT");
    expect(all).toContain("110 mm (largeur, travers tête) × 210 mm (longueur, avance)");
    expect(all).toContain("210 × 110 mm paysage");
    expect(all).toContain("É È À Ç");
    expect(svgTexts(svg)).toContain("Poste : POSTE-1");
    expect(layout.elements.find((e) => e.role === "up-arrow")?.type).toBe("poly");
    // Edge guide 1 mm inside the printed band: 1 mm from the 210 mm edges, 3 + 1 mm across (110 mm roll, 104 mm head).
    expect(layout.elements.find((e) => e.role === "guide-edge")).toMatchObject({ x: 8, y: 32 });
    const ruler = layout.elements.find((e) => e.role === "scale-ruler");
    expect(ruler && ruler.type === "rect" && ruler.width).toBe(50 * 8);
    expect(testRulerMm(c)).toBe(50);
    expect(layout.elements.find((e): e is QrElement => e.type === "qr")!.data).toBe(TEST_QR_DATA);
  });

  it("escapes text safely in the SVG", () => {
    const { svg } = renderLabel({ ...notOk, operator: "A<B&C" }, cfg(), printOpts(cfg()));
    expect(svg).toContain("A&lt;B&amp;C");
    expect(svg).not.toContain("A<B");
  });

  it("ROTATE_90 keeps the portrait page and turns the content once inside the SVG", () => {
    const c = cfg(100, 150, "ROTATE_90");
    const layout = buildLayout(ok, c);
    const svg = renderSvg(layout, { qrMatrix, physical: { widthMm: 100, heightMm: 150 } });
    expect(svg).toMatch(/width="100mm" height="150mm"/);
    expect(svg).toContain('<g transform="translate(800 0) rotate(90)">');
    expect(svg.match(/rotate\(/g)).toHaveLength(1);
    expect(renderSvg(layout, { qrMatrix })).not.toContain("rotate(");
  });
});

describe("layout validation for the configured stock", () => {
  it("places a shorter print area at the top, centre or bottom of a 400 mm sheet without scaling text or the QR", () => {
    const layouts = (["TOP", "CENTER", "BOTTOM"] as const).map((contentPosition) => buildLayout(ok, { ...cfg(110, 400, "ROTATE_90"), contentLengthMm: 210, contentPosition }));
    const topQr = layouts[0].elements.find((e): e is QrElement => e.type === "qr")!;
    for (const [i, layout] of layouts.entries()) {
      expect(layout.frame).toMatchObject({ pageWidthMm: 110, pageHeightMm: 400, readingWidthMm: 400, readingHeightMm: 110 });
      const qr = layout.elements.find((e): e is QrElement => e.type === "qr")!;
      expect(qr).toMatchObject({ data: GALIA, y: topQr.y, magnification: topQr.magnification, quietZone: topQr.quietZone, x: topQr.x + i * 95 * 8 });
      expect(texts(layout).map((t) => t.fontHeight)).toEqual(texts(layouts[0]).map((t) => t.fontHeight));
      const svg = renderSvg(layout, { qrMatrix, physical: { widthMm: 110, heightMm: 400 } });
      expect(svg).toMatch(/width="110mm" height="400mm"/);
      expect(svgQrPath(svg)).toBe(expectedQrPath(qrMatrix(GALIA), qr.x, qr.y, qr.magnification));
      expect(svg.match(/rotate\(90\)/g)).toHaveLength(1);
    }
    const portraitTop = buildLayout(notOk, { ...cfg(110, 400, "NONE"), contentLengthMm: 210, contentPosition: "TOP" });
    const portraitBottom = buildLayout(notOk, { ...cfg(110, 400, "NONE"), contentLengthMm: 210, contentPosition: "BOTTOM" });
    expect(texts(portraitBottom)[0].y - texts(portraitTop)[0].y).toBe(190 * 8);
  });

  it("full-paper mode spans 400 mm and a positioned TEST still describes the real 400 mm stock", () => {
    const full = buildLayout(ok, { ...cfg(110, 400), contentLengthMm: null, contentPosition: "CENTER" });
    expect(full.widthDots).toBe(400 * 8);
    expect(texts(full).find((e) => e.role === "result")!.fontHeight).toBeGreaterThan(50 * 8);
    const operator = texts(full).find((e) => e.role === "operator")!;
    expect(operator.x + operator.width).toBe(398.5 * 8);
    expect(full.elements.find((e) => e.role === "result-frame")).toMatchObject({ x: 1.5 * 8 });
    const wideNok = renderLabel(notOk, { ...cfg(110, 400), contentLengthMm: null }, { qrMatrix });
    expect(texts(wideNok.layout).find((e) => e.role === "result")!.fontHeight).toBeGreaterThan(30 * 8);
    expect(svgQrPath(wideNok.svg)).toBeNull();
    expect(wideNok.svg).not.toContain("<path");
    const test = renderLabel({ template: "TEST", operator: "OP042", workstationName: "POSTE-1" }, { ...cfg(110, 400, "ROTATE_90"), contentLengthMm: 210, contentPosition: "BOTTOM" }, { qrMatrix, physical: { widthMm: 110, heightMm: 400 } });
    expect(svgTexts(test.svg).join(" ")).toContain("400 mm (longueur, avance)");
    expect(svgTexts(test.svg).join(" ")).toContain("110 × 400 mm portrait");
    expect(test.layout.elements.find((e) => e.role === "scale-ruler")).toMatchObject({ width: 50 * 8 });
    expect(() => buildLayout(ok, { ...cfg(110, 400), contentLengthMm: 401 })).toThrow(/zone imprimée/);
    expect(() => buildLayout(ok, { ...cfg(110, 400), contentLengthMm: 0 })).toThrow(/zone imprimée/);
  });

  it("defaults to a roll-size page with one internal rotation, preserving the horizontal reading direction", () => {
    const c: LabelConfig = { widthMm: 110, heightMm: 210, dpi: 203, accentMode: "UTF8" };
    expect(labelFrame(c)).toMatchObject({ orientation: "ROTATE_90", rotation: 90, pageWidthMm: 110, pageHeightMm: 210, readingWidthMm: 210, readingHeightMm: 110 });
    const layout = buildLayout(ok, c);
    const svg = renderSvg(layout, { qrMatrix, physical: { widthMm: 110, heightMm: 210 } });
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 880 1680" width="110mm" height="210mm"/);
    expect(svg.match(/rotate\(90\)/g)).toHaveLength(1);
    expect(layout.marginYDots).toBe(4.5 * 8);
    expect(layout.marginDots).toBe(1.5 * 8);
    const qr = layout.elements.find((el): el is QrElement => el.type === "qr")!;
    expect(qr.data).toBe(GALIA);
    expect(svgQrPath(svg)).toBe(expectedQrPath(qrMatrix(GALIA), qr.x, qr.y, qr.magnification));
  });

  it("allows the real feed length beyond 200/300 mm, while keeping everything within the 104 mm head", () => {
    for (const length of [210, 400, 991]) {
      for (const content of [ok, notOk, ...worstCaseContents()]) {
        const layout = buildLayout(content, cfg(112, length, "ROTATE_90"));
        expect(layout.frame.pageWidthMm).toBe(112);
        expect(layout.frame.pageHeightMm).toBe(length);
        for (const el of layout.elements) {
          expect(bounds(el).y).toBeGreaterThanOrEqual(5 * 8); // 4 mm overhang + at least 1 mm guide safety
          expect(bounds(el).y + bounds(el).h).toBeLessThanOrEqual((112 - 5) * 8);
        }
      }
    }
    expect(() => buildLayout(ok, cfg(110, 992))).toThrow(/Longueur/);
  });

  it.each([
    [110, 210, "LANDSCAPE"],
    [104, 210, "LANDSCAPE"],
    [100, 150, "LANDSCAPE"],
    [104, 300, "LANDSCAPE"],
    [100, 100, "LANDSCAPE"],
    [100, 150, "ROTATE_90"],
    [80, 120, "ROTATE_90"],
    [100, 150, "NONE"],
  ] as const)("keeps every element of every label inside its area on %i × %i mm (%s)", (w, h, orientation) => {
    for (const content of [ok, notOk, { ...ok, reprint: true }, { template: "TEST" as const, operator: "OP042", workstationName: "POSTE-1" }]) {
      const layout = buildLayout(content, cfg(w, h, orientation));
      for (const el of layout.elements) {
        const b = bounds(el);
        const guide = el.role.startsWith("guide-");
        expect(b.x).toBeGreaterThanOrEqual(guide ? 8 : layout.marginDots);
        expect(b.y).toBeGreaterThanOrEqual(guide ? 8 : layout.marginYDots);
        expect(b.x + b.w).toBeLessThanOrEqual(layout.widthDots - (guide ? 8 : layout.marginDots));
        expect(b.y + b.h).toBeLessThanOrEqual(layout.heightDots - (guide ? 8 : layout.marginYDots));
      }
      expect(layout.pageWidthDots).toBe(layout.frame.pageWidthMm * 8);
      expect(layout.pageHeightDots).toBe(layout.frame.pageHeightMm * 8);
    }
  });

  it("the worst-case contents used before a label size is confirmed fit the plant stock and 100 × 100 mm", () => {
    for (const c of [cfg(), cfg(100, 100), cfg(100, 150, "ROTATE_90")]) for (const content of worstCaseContents()) expect(() => buildLayout(content, c)).not.toThrow();
  });

  it("wraps or shrinks long identifiers without truncating them", () => {
    const longPn = "L".padEnd(40, "7");
    const longSerial = "1".repeat(30);
    const layout = buildLayout({ ...ok, partNumber: longPn, boxSerial: longSerial, operator: "W".repeat(32), galiaPayload: `P${longPn}_Q999_S${longSerial}` }, cfg(100, 100));
    const joined = (prefix: string) => texts(layout).filter((t) => t.role.startsWith(prefix) && !t.role.endsWith("caption")).map((t) => t.text).join("");
    expect(joined("part-number")).toBe(longPn);
    expect(joined("box-serial")).toBe(longSerial);
    expect(joined("operator")).toBe("W".repeat(32));
  });

  it("never truncates issue lines and never starts a line with « : »", () => {
    const lines = ["MANQUANT : 999 pièces", "EXCÉDENT : 999 pièces", "RÉFÉRENCE DIFFÉRENTE : 999 pièces", "SÉRIE DÉJÀ UTILISÉE : 999 pièces", "SCAN EN DOUBLE : 999 tentatives", "FORMAT INVALIDE : 999 tentatives"];
    const layout = buildLayout({ ...notOk, figures: { ...notOk.figures, lines } }, cfg(100, 100));
    const shown = texts(layout).filter((t) => t.role.startsWith("issue-"));
    for (const [i, line] of lines.entries()) {
      const parts = shown.filter((t) => t.role === `issue-${i + 1}` || t.role.startsWith(`issue-${i + 1}-`)).map((t) => t.text);
      expect(parts.join(" ")).toBe(line);
      for (const p of parts) expect(p.startsWith(":")).toBe(false);
    }
  });

  it("refuses stock too small for the content with a layout error instead of clipping", () => {
    expect(() => buildLayout(ok, cfg(50, 50))).toThrow(LabelLayoutError);
    expect(() => buildLayout(ok, cfg(50, 50))).toThrow(/rien n'a été imprimé/);
  });

  it("refuses an unsupported size", () => {
    expect(() => buildLayout(ok, cfg(992, 210))).toThrow(/Largeur/);
    expect(() => buildLayout(ok, cfg(110, 20))).toThrow(/Longueur/);
  });

  it.each(["NONE", "ROTATE_90", "LANDSCAPE"] as const)("uses a custom width beyond 112 mm without stretching the QR (%s)", (orientation) => {
    const paper = cfg(160, 400, orientation);
    const legacy = buildLayout(ok, paper);
    const expanded = buildLayout(ok, { ...paper, printableWidthMm: null });
    expect(legacy.frame.acrossOverhangMm).toBe(28);
    expect(expanded.frame.acrossOverhangMm).toBe(0);
    expect(expanded.fitScale).toBeGreaterThan(legacy.fitScale);
    for (const content of [ok, notOk, ...worstCaseContents()]) {
      const config = { ...paper, printableWidthMm: null };
      const layout = buildLayout(content, config);
      for (const el of layout.elements) {
        const b = bounds(el);
        expect(b.x).toBeGreaterThanOrEqual(8);
        expect(b.y).toBeGreaterThanOrEqual(8);
        expect(b.x + b.w).toBeLessThanOrEqual(layout.widthDots - 8);
        expect(b.y + b.h).toBeLessThanOrEqual(layout.heightDots - 8);
      }
      if (content.template === "OK") {
        const qr = layout.elements.find((e): e is QrElement => e.type === "qr")!;
        expect(qr.data).toBe(content.galiaPayload);
        expect(svgQrPath(renderSvg(layout, { qrMatrix }))).toBe(expectedQrPath(qrMatrix(qr.data), qr.x, qr.y, qr.magnification));
      } else if (content.template === "NOT_OK") expect(svgQrPath(renderSvg(layout))).toBeNull();
    }
    expect(labelFrame({ ...paper, printableWidthMm: 140 }).acrossOverhangMm).toBe(10);
    expect(labelFrame({ ...paper, printableWidthMm: 200 }).acrossOverhangMm).toBe(0);
    expect(() => buildLayout(ok, { ...paper, printableWidthMm: 0 })).toThrow(/Largeur imprimable/);
  });
});
