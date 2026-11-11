/**
 * Shared label layout model (the folder keeps its historical "zpl" name).
 *
 * All coordinates are computed here in abstract units (the app uses 8 units/mm),
 * from the configured physical label size. The model is rendered to SVG with a
 * physical size in millimetres, printed through the browser print dialog, and is
 * validated against the printable area before anything is printed.
 */
import type { AccentMode } from "./encode";
import { isQrSafePayload, toAsciiVocabulary } from "./encode";

/**
 * Template version recorded on every print job. v2 = HTML/SVG label printed through
 * the browser print dialog (v1 was ZPL for Zebra Browser Print).
 */
export const TEMPLATE_VERSION = "galia-label-v2-html";

export type Dpi = 203 | 300;
export const DOTS_PER_MM: Record<Dpi, number> = { 203: 8, 300: 12 };

/** ZD421 maximum print width is 104 mm; labels below 50 mm cannot hold these layouts. */
export const LABEL_LIMITS = { widthMinMm: 50, widthMaxMm: 104, heightMinMm: 50, heightMaxMm: 200 } as const;

/** Conservative average glyph width of Zebra font 0 relative to its height (width = height). */
export const CHAR_WIDTH_RATIO = 0.62;
export const MARGIN_MM = 3;

export interface LabelConfig {
  widthMm: number;
  heightMm: number;
  dpi: Dpi;
  accentMode: AccentMode;
}

export interface OkContent {
  template: "OK";
  operator: string;
  partNumber: string;
  quantity: number;
  boxSerial: string;
  galiaPayload: string;
  reprint: boolean;
}

export interface NotOkContent {
  template: "NOT_OK";
  operator: string;
  partNumber: string;
  qtyFound: number;
  reprint: boolean;
}

export interface TestContent {
  template: "TEST";
  operator: string;
  workstationName: string;
}

export type LabelContent = OkContent | NotOkContent | TestContent;

export interface TextElement {
  type: "text";
  role: string;
  x: number;
  y: number;
  width: number;
  fontHeight: number;
  text: string;
  align: "L" | "C" | "R";
  reverse: boolean;
}

export interface RectElement {
  type: "rect";
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
  thickness: number;
  filled: boolean;
}

export interface QrElement {
  type: "qr";
  role: string;
  x: number;
  y: number;
  magnification: number;
  modules: number;
  quietZone: number;
  data: string;
}

export type LayoutElement = TextElement | RectElement | QrElement;

export interface LabelLayout {
  template: LabelContent["template"];
  widthDots: number;
  heightDots: number;
  dpi: Dpi;
  dotsPerMm: number;
  marginDots: number;
  accentMode: AccentMode;
  elements: LayoutElement[];
}

export type LabelLayoutErrorCode = "INVALID_CONFIG" | "TEXT_TOO_LONG" | "LABEL_TOO_SMALL" | "OUT_OF_BOUNDS" | "OVERLAP";

export class LabelLayoutError extends Error {
  constructor(
    public readonly code: LabelLayoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LabelLayoutError";
  }
}

export function validateConfig(config: LabelConfig): void {
  const { widthMm, heightMm, dpi, accentMode } = config;
  if (dpi !== 203 && dpi !== 300) throw new LabelLayoutError("INVALID_CONFIG", "Résolution invalide : choisir 203 ou 300 dpi.");
  if (!Number.isInteger(widthMm) || widthMm < LABEL_LIMITS.widthMinMm || widthMm > LABEL_LIMITS.widthMaxMm) {
    throw new LabelLayoutError("INVALID_CONFIG", `Largeur invalide (${LABEL_LIMITS.widthMinMm}–${LABEL_LIMITS.widthMaxMm} mm).`);
  }
  if (!Number.isInteger(heightMm) || heightMm < LABEL_LIMITS.heightMinMm || heightMm > LABEL_LIMITS.heightMaxMm) {
    throw new LabelLayoutError("INVALID_CONFIG", `Hauteur invalide (${LABEL_LIMITS.heightMinMm}–${LABEL_LIMITS.heightMaxMm} mm).`);
  }
  if (accentMode !== "UTF8" && accentMode !== "ASCII") throw new LabelLayoutError("INVALID_CONFIG", "Mode d'accents invalide.");
}

export function estimateTextWidth(text: string, fontHeight: number): number {
  return Math.ceil([...text].length * fontHeight * CHAR_WIDTH_RATIO);
}

/** QR byte-mode capacity, error correction level Q, versions 1..10 (ISO/IEC 18004). */
const QR_Q_BYTE_CAPACITY = [11, 20, 32, 46, 60, 74, 86, 108, 130, 151];

/** Upper bound of the QR symbol size (modules per side) for a payload length. */
export function qrModules(length: number): number {
  const version = QR_Q_BYTE_CAPACITY.findIndex((cap) => length <= cap) + 1;
  if (version === 0) throw new LabelLayoutError("TEXT_TOO_LONG", "Contenu QR trop long.");
  return 17 + 4 * version;
}

interface FittedText {
  lines: string[];
  fontHeight: number;
}

/**
 * Fit text in `maxWidth` dots: shrink the font from `preferred` down to `min`,
 * then wrap onto up to `maxLines` lines. Never truncates: throws instead.
 */
export function fitText(text: string, maxWidth: number, preferred: number, min: number, maxLines: number): FittedText {
  const chars = [...text];
  for (let lines = 1; lines <= maxLines; lines++) {
    const perLine = Math.ceil(chars.length / lines);
    const fontHeight = Math.min(preferred, Math.floor(maxWidth / (Math.max(perLine, 1) * CHAR_WIDTH_RATIO)));
    if (fontHeight >= min) {
      const out: string[] = [];
      for (let i = 0; i < chars.length; i += perLine) out.push(chars.slice(i, i + perLine).join(""));
      return { lines: out, fontHeight };
    }
  }
  throw new LabelLayoutError("TEXT_TOO_LONG", `Texte trop long pour l'étiquette : « ${text} ». Agrandir l'étiquette.`);
}

class Builder {
  readonly dotsPerMm: number;
  readonly W: number;
  readonly H: number;
  readonly m: number;
  readonly innerW: number;
  readonly s: number;
  readonly elements: LayoutElement[] = [];

  constructor(readonly config: LabelConfig, marginMm = MARGIN_MM) {
    this.dotsPerMm = DOTS_PER_MM[config.dpi];
    this.W = Math.round(config.widthMm * this.dotsPerMm);
    this.H = Math.round(config.heightMm * this.dotsPerMm);
    this.m = this.mm(marginMm);
    this.innerW = this.W - 2 * this.m;
    this.s = Math.min(2, Math.max(0.5, Math.min(config.widthMm, config.heightMm) / 100));
  }

  mm(value: number): number {
    return Math.round(value * this.dotsPerMm);
  }

  /** Font sizes scale with the label; minimums stay absolute for readability. */
  smm(value: number): number {
    return this.mm(value * this.s);
  }

  text(role: string, x: number, y: number, width: number, fontHeight: number, text: string, align: TextElement["align"], reverse = false) {
    this.elements.push({ type: "text", role, x, y, width, fontHeight, text, align, reverse });
  }

  /** Fitted (possibly wrapped) text block; returns the y below it. */
  block(role: string, text: string, x: number, y: number, width: number, preferred: number, min: number, maxLines: number, align: TextElement["align"]): number {
    const fit = fitText(text, width, preferred, min, maxLines);
    const gap = this.mm(0.8);
    fit.lines.forEach((line, i) => this.text(fit.lines.length > 1 ? `${role}-${i + 1}` : role, x, y + i * (fit.fontHeight + gap), width, fit.fontHeight, line, align));
    return y + fit.lines.length * fit.fontHeight + (fit.lines.length - 1) * gap;
  }

  /** Caption + value pair; returns the y below it. */
  field(role: string, caption: string, value: string, x: number, y: number, width: number, preferred: number, min: number, maxLines: number): number {
    const capH = Math.max(this.mm(2.5), this.smm(3));
    this.text(`${role}-caption`, x, y, width, capH, caption, "L");
    const bottom = this.block(role, value, x, y + capH + this.mm(0.8), width, preferred, min, maxLines, "L");
    return bottom + this.smm(2.5);
  }

  rect(role: string, x: number, y: number, width: number, height: number, thickness: number, filled: boolean) {
    this.elements.push({ type: "rect", role, x, y, width, height, thickness, filled });
  }

  /** Header: optional marker on the left, finalizing operator in the TOP-RIGHT corner. */
  header(operator: string, marker: string | null, y: number): number {
    const rightW = Math.floor(this.innerW * 0.6);
    const rightX = this.W - this.m - rightW;
    const capH = Math.max(this.mm(2.5), this.smm(3));
    this.text("operator-caption", rightX, y, rightW, capH, "OPÉRATEUR", "R");
    const rightBottom = this.block("operator", operator, rightX, y + capH + this.mm(0.8), rightW, this.smm(7), this.mm(3.5), 2, "R");

    let leftBottom = y;
    if (marker) {
      const leftW = this.innerW - rightW - this.mm(2);
      const pad = this.mm(1);
      const fit = fitText(marker, leftW - 2 * pad, this.smm(4.5), this.mm(2.5), 1);
      this.rect("marker-background", this.m, y, leftW, fit.fontHeight + 2 * pad, 0, true);
      this.text("marker", this.m + pad, y + pad, leftW - 2 * pad, fit.fontHeight, fit.lines[0], "C", true);
      leftBottom = y + fit.fontHeight + 2 * pad;
    }
    return Math.max(leftBottom, rightBottom);
  }

  ensureFits(bottom: number) {
    if (bottom > this.H - this.m) {
      throw new LabelLayoutError("LABEL_TOO_SMALL", "Contenu plus grand que l'étiquette : augmenter la hauteur configurée.");
    }
  }

  layout(template: LabelContent["template"]): LabelLayout {
    return {
      template,
      widthDots: this.W,
      heightDots: this.H,
      dpi: this.config.dpi,
      dotsPerMm: this.dotsPerMm,
      marginDots: this.m,
      accentMode: this.config.accentMode,
      elements: this.elements,
    };
  }
}

const REPRINT_MARKER = "RÉIMPRESSION";
export const TEST_MARKER = "TEST — NE PAS UTILISER";
/** Deliberately not a valid GALIA payload, so a scanned test label is rejected by the app. */
export const TEST_QR_DATA = "TEST_NE_PAS_UTILISER";

function qrMagnification(b: Builder): number {
  // ~0.6 mm modules: 5 dots at 8 dots/mm, 7 dots at 12 dots/mm.
  return b.config.dpi === 203 ? 5 : 7;
}

function buildOk(c: OkContent, b: Builder): LabelLayout {
  if (!isQrSafePayload(c.galiaPayload)) {
    throw new LabelLayoutError("INVALID_CONFIG", "Contenu QR refusé : seuls A–Z, 0–9 et « _ » sont autorisés.");
  }
  let y = b.header(c.operator, c.reprint ? REPRINT_MARKER : null, b.m);
  y += b.mm(2);

  // Result: very large "OK" inside a heavy frame.
  const frameH = b.smm(30);
  const t = Math.max(b.mm(1.2), b.smm(1.5));
  b.rect("result-frame", b.m, y, b.innerW, frameH, t, false);
  const fit = fitText("OK", b.innerW - 2 * t - b.mm(4), b.smm(24), b.mm(10), 1);
  b.text("result", b.m, y + Math.floor((frameH - fit.fontHeight) / 2), b.innerW, fit.fontHeight, "OK", "C");
  y += frameH + b.smm(3);

  // QR (exact GALIA payload) on the left, box data on the right.
  const mag = qrMagnification(b);
  const modules = qrModules(c.galiaPayload.length);
  const qrSize = modules * mag;
  const quiet = 4 * mag;
  b.elements.push({ type: "qr", role: "galia-qr", x: b.m + quiet, y: y + quiet, magnification: mag, modules, quietZone: quiet, data: c.galiaPayload });

  const colX = b.m + qrSize + 2 * quiet + b.mm(1);
  const colW = b.W - b.m - colX;
  if (colW < b.mm(25)) throw new LabelLayoutError("LABEL_TOO_SMALL", "Étiquette trop étroite pour le QR et les données.");
  let cy = y;
  cy = b.field("part-number", "PN", c.partNumber, colX, cy, colW, b.smm(7), b.mm(3), 2);
  cy = b.field("quantity", "QTY", String(c.quantity), colX, cy, colW, b.smm(9), b.mm(4), 1);
  cy = b.field("box-serial", "BOX S/N", c.boxSerial, colX, cy, colW, b.smm(6), b.mm(3), 2);

  b.ensureFits(Math.max(cy - b.smm(2.5), y + qrSize + 2 * quiet));
  return b.layout("OK");
}

function buildNotOk(c: NotOkContent, b: Builder): LabelLayout {
  let y = b.header(c.operator, c.reprint ? REPRINT_MARKER : null, b.m);
  y += b.mm(2);

  // Result: very large "NOT OK", white on a solid black block (unmistakable in black & white).
  const blockH = b.smm(30);
  b.rect("result-block", b.m, y, b.innerW, blockH, 0, true);
  const fit = fitText("NOT OK", b.innerW - b.mm(6), b.smm(22), b.mm(8), 1);
  b.text("result", b.m, y + Math.floor((blockH - fit.fontHeight) / 2), b.innerW, fit.fontHeight, "NOT OK", "C", true);
  y += blockH + b.smm(4);

  y = b.field("part-number", "PN", c.partNumber, b.m, y, b.innerW, b.smm(9), b.mm(3.5), 2);
  const bottom = b.block("qty-found", `QTY FOUND: ${c.qtyFound}`, b.m, y, b.innerW, b.smm(11), b.mm(4), 1, "L");

  b.ensureFits(bottom);
  return b.layout("NOT_OK");
}

function buildTest(c: TestContent, b0: LabelConfig): LabelLayout {
  // Content is inset 2 mm inside a frame drawn on the printable margin, so the
  // frame itself shows whether the configured size matches the physical stock.
  const b = new Builder(b0, MARGIN_MM + 2);
  const frameM = Math.round(MARGIN_MM * b.dotsPerMm);
  b.rect("printable-area", frameM, frameM, b.W - 2 * frameM, b.H - 2 * frameM, 2, false);

  let y = b.header(c.operator, null, b.m);
  y += b.mm(2);
  const fit = fitText(TEST_MARKER, b.innerW - b.mm(4), b.smm(6), b.mm(3), 2);
  const pad = b.mm(1.5);
  const gap = b.mm(0.8);
  const blockH = fit.lines.length * fit.fontHeight + (fit.lines.length - 1) * gap + 2 * pad;
  b.rect("test-block", b.m, y, b.innerW, blockH, 0, true);
  fit.lines.forEach((line, i) => b.text(`test-marker-${i + 1}`, b.m, y + pad + i * (fit.fontHeight + gap), b.innerW, fit.fontHeight, line, "C", true));
  y += blockH + b.smm(3);

  const lineH = Math.max(b.mm(3), b.smm(3.5));
  const lines = [
    `Poste : ${c.workstationName}`,
    `Format : ${b0.widthMm} x ${b0.heightMm} mm`,
    b0.accentMode === "UTF8" ? "Accents : É È À Ç Ô Ù" : "Mode sans accents (ASCII)",
    `Modèle : ${TEMPLATE_VERSION}`,
  ];
  for (const [i, line] of lines.entries()) {
    y = b.block(`test-line-${i + 1}`, line, b.m, y, b.innerW, lineH, b.mm(2.5), 2, "L") + b.mm(1.5);
  }

  // Scale check: a bar of a whole number of centimetres; measured with a ruler it must
  // match exactly when the browser prints at 100 % / actual size.
  const rulerMm = Math.min(50, Math.floor((b.innerW / b.dotsPerMm) / 10) * 10);
  y = b.block("scale-caption", `Règle : ${rulerMm} mm exactement (échelle 100 %)`, b.m, y, b.innerW, lineH, b.mm(2.5), 2, "L") + b.mm(1);
  b.rect("scale-ruler", b.m, y, b.mm(rulerMm), b.mm(1.5), 0, true);
  for (let cm = 0; cm <= rulerMm / 10; cm++) b.rect(`scale-tick-${cm}`, b.m + b.mm(cm * 10) - (cm === rulerMm / 10 ? b.mm(0.4) : 0), y, b.mm(0.4), b.mm(3), 0, true);
  y += b.mm(4);

  const mag = qrMagnification(b);
  const modules = qrModules(TEST_QR_DATA.length);
  const quiet = 4 * mag;
  b.elements.push({ type: "qr", role: "test-qr", x: b.m + quiet, y: y + quiet, magnification: mag, modules, quietZone: quiet, data: TEST_QR_DATA });
  b.ensureFits(y + modules * mag + 2 * quiet);
  return b.layout("TEST");
}

interface Box2D {
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function boundsOf(el: LayoutElement): Box2D {
  if (el.type === "text") return { role: el.role, x: el.x, y: el.y, w: el.width, h: el.fontHeight };
  if (el.type === "rect") return { role: el.role, x: el.x, y: el.y, w: el.width, h: el.height };
  const size = el.modules * el.magnification;
  return { role: el.role, x: el.x - el.quietZone, y: el.y - el.quietZone, w: size + 2 * el.quietZone, h: size + 2 * el.quietZone };
}

/** Visible width a text element really needs (for overlap checks of aligned text). */
function inkBounds(el: TextElement): Box2D {
  const shown = el.text;
  const w = Math.min(el.width, estimateTextWidth(shown, el.fontHeight));
  const x = el.align === "L" ? el.x : el.align === "R" ? el.x + el.width - w : el.x + Math.floor((el.width - w) / 2);
  return { role: el.role, x, y: el.y, w, h: el.fontHeight };
}

function intersects(a: Box2D, b: Box2D): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Validate a layout against the printable area: every element inside the
 * margins, every text fitting its block, no text/QR overlapping another.
 */
export function validateLayout(layout: LabelLayout): void {
  const m = layout.marginDots;
  const frameMargin = Math.round(MARGIN_MM * layout.dotsPerMm);
  for (const el of layout.elements) {
    const bx = boundsOf(el);
    const minEdge = el.type === "rect" ? Math.min(m, frameMargin) : m;
    if (bx.x < minEdge || bx.y < minEdge || bx.x + bx.w > layout.widthDots - minEdge || bx.y + bx.h > layout.heightDots - minEdge) {
      throw new LabelLayoutError("OUT_OF_BOUNDS", `Élément « ${el.role} » hors de la zone imprimable.`);
    }
    if (el.type === "text") {
      if (el.fontHeight <= 0 || el.width <= 0) throw new LabelLayoutError("OUT_OF_BOUNDS", `Élément « ${el.role} » invalide.`);
      const shown = layout.accentMode === "ASCII" ? toAsciiVocabulary(el.text) : el.text;
      if (estimateTextWidth(shown, el.fontHeight) > el.width) {
        throw new LabelLayoutError("TEXT_TOO_LONG", `Texte « ${el.role} » plus large que sa zone.`);
      }
    }
  }
  const solid = layout.elements.filter((e): e is TextElement | QrElement => e.type !== "rect");
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i].type === "text" ? inkBounds(solid[i] as TextElement) : boundsOf(solid[i]);
      const c = solid[j].type === "text" ? inkBounds(solid[j] as TextElement) : boundsOf(solid[j]);
      if (intersects(a, c)) {
        throw new LabelLayoutError("OVERLAP", `Chevauchement entre « ${a.role} » et « ${c.role} ».`);
      }
    }
  }
}

/** Build and validate the layout for a content + printer configuration. */
export function buildLayout(content: LabelContent, config: LabelConfig): LabelLayout {
  validateConfig(config);
  let layout: LabelLayout;
  if (content.template === "TEST") layout = buildTest(content, config);
  else if (content.template === "OK") layout = buildOk(content, new Builder(config));
  else layout = buildNotOk(content, new Builder(config));
  validateLayout(layout);
  return layout;
}
