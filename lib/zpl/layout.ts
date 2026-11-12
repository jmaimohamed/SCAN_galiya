/**
 * Shared label layout model (the folder keeps its historical "zpl" name).
 *
 * Geometry (Zebra ZD421, 203 dpi = 8 dots/mm; 1 layout unit = 1 printer dot)
 *  - `widthMm`  = label / roll width ACROSS the printhead (e.g. 110 mm). The
 *    ZD421 head prints at most 104 mm: anything wider gets extra side margins.
 *  - `heightMm` = label length ALONG the feed (e.g. 210 mm).
 *  - Orientation LANDSCAPE (legacy alternative): the page itself is landscape, heightMm ×
 *    widthMm (e.g. 210 × 110 mm); the Windows driver turns it ONCE onto the
 *    roll. The label is read held horizontally, text along the 210 mm length.
 *  - Orientation ROTATE_90 (default): portrait page widthMm × heightMm; the landscape
 *    content is turned 90° once inside the SVG (the driver must not rotate).
 *  - Orientation NONE: portrait page, portrait content, no rotation.
 *
 * The content GROWS to fill the label: the largest size factor that still fits
 * is searched (fonts, result block, QR). Text widths use Arial Bold metrics, so
 * text keeps its natural shape. Content that cannot fit even at the minimum
 * legible sizes raises a LabelLayoutError — never clipped, never truncated.
 */
import type { AccentMode } from "./encode";
import { isQrSafePayload, toAsciiVocabulary } from "./encode";

/**
 * Template version recorded on every print job.
 * v5 = roll-size page, larger type and smaller safe margins. Earlier snapshots stay unchanged.
 */
export const TEMPLATE_VERSION = "galia-label-v6-placement";

export type Dpi = 203 | 300;
export const DOTS_PER_MM: Record<Dpi, number> = { 203: 8, 300: 12 };

/** ZD421 thermal-transfer roll ≤ 112 mm; printable band ≤ 104 mm at 203 dpi; length ≤ 991 mm. */
export const LABEL_LIMITS = { widthMinMm: 50, widthMaxMm: 112, heightMinMm: 50, heightMaxMm: 991 } as const;
/** ZD421 (203 dpi) maximum print width. */
export const PRINTHEAD_MAX_MM = 104;

/** Safe margin on every edge (label registration drift of the ZD421 ≈ ±1 mm). */
export const MARGIN_MM = 1.5;
/** Absolute minimum font size (≈ 1.8 mm capital height, legible at 203 dpi). */
export const MIN_FONT_MM = 2.5;

export type Orientation = "LANDSCAPE" | "ROTATE_90" | "NONE";
export type ContentPosition = "TOP" | "CENTER" | "BOTTOM";
export const ORIENTATIONS: readonly Orientation[] = ["LANDSCAPE", "ROTATE_90", "NONE"];

export interface LabelConfig {
  widthMm: number;
  heightMm: number;
  dpi: Dpi;
  accentMode: AccentMode;
  /** Default ROTATE_90: physical page matches the roll, with horizontal reading. */
  orientation?: Orientation;
  /** Along the physical feed, before the one reading-direction rotation. */
  contentPosition?: ContentPosition;
  /** Optional shorter print area; omitted/null fills the measured paper length. */
  contentLengthMm?: number | null;
}

/** Quantities printed on result labels (from one immutable report). */
export interface LabelFigures {
  expected: number;
  /** Distinct cover identities scanned. */
  distinct: number;
  conforming: number;
  nonconforming: number;
  /** Concise French issue lines (or the single CONFORME line). */
  lines: string[];
}

export interface OkContent {
  template: "OK";
  operator: string;
  partNumber: string;
  boxSerial: string;
  galiaPayload: string;
  figures: LabelFigures;
  /** Display date/time of the finalization (Africa/Tunis). */
  finalizedAt: string;
  reprint: boolean;
}

export interface NotOkContent {
  template: "NOT_OK";
  operator: string;
  partNumber: string;
  boxSerial: string;
  figures: LabelFigures;
  finalizedAt: string;
  reprint: boolean;
}

export interface TestContent {
  template: "TEST";
  operator: string;
  workstationName: string;
  /** Internal: keep physical stock information when laying out a shorter print area. */
  stockLengthMm?: number;
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

/** Filled polygon (orientation arrow of the TEST label). */
export interface PolyElement {
  type: "poly";
  role: string;
  points: [number, number][];
}

export type LayoutElement = TextElement | RectElement | QrElement | PolyElement;

export interface LabelFrame {
  orientation: Orientation;
  /** Rotation applied once, in the SVG, from the reading frame to the page (LANDSCAPE: the driver turns the page). */
  rotation: 0 | 90;
  /** Page sent to the browser print dialog (`@page size`). */
  pageWidthMm: number;
  pageHeightMm: number;
  /** Frame the content is laid out and read in. */
  readingWidthMm: number;
  readingHeightMm: number;
  /** Axis of the reading frame that lies across the printhead. */
  acrossAxis: "x" | "y";
  /** Unprintable band on each side of the roll when it is wider than the head (mm). */
  acrossOverhangMm: number;
}

export interface LabelLayout {
  template: LabelContent["template"];
  /** Reading frame (all element coordinates). */
  widthDots: number;
  heightDots: number;
  /** Printed page. */
  pageWidthDots: number;
  pageHeightDots: number;
  frame: LabelFrame;
  dpi: Dpi;
  dotsPerMm: number;
  /** Content margins of the reading frame (x = left/right, y = top/bottom). */
  marginDots: number;
  marginYDots: number;
  accentMode: AccentMode;
  /** Size factor that fills the label (1 = nominal sizes for a 150 × 100 mm frame). */
  fitScale: number;
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
    throw new LabelLayoutError("INVALID_CONFIG", `Largeur (travers de la tête) invalide : ${LABEL_LIMITS.widthMinMm}–${LABEL_LIMITS.widthMaxMm} mm.`);
  }
  if (!Number.isInteger(heightMm) || heightMm < LABEL_LIMITS.heightMinMm || heightMm > LABEL_LIMITS.heightMaxMm) {
    throw new LabelLayoutError("INVALID_CONFIG", `Longueur (sens d'avance) invalide : ${LABEL_LIMITS.heightMinMm}–${LABEL_LIMITS.heightMaxMm} mm.`);
  }
  if (accentMode !== "UTF8" && accentMode !== "ASCII") throw new LabelLayoutError("INVALID_CONFIG", "Mode d'accents invalide.");
  if (config.orientation !== undefined && !ORIENTATIONS.includes(config.orientation)) throw new LabelLayoutError("INVALID_CONFIG", "Orientation invalide.");
  if (config.contentPosition !== undefined && !["TOP", "CENTER", "BOTTOM"].includes(config.contentPosition)) throw new LabelLayoutError("INVALID_CONFIG", "Position invalide.");
  if (config.contentLengthMm != null && (!Number.isInteger(config.contentLengthMm) || config.contentLengthMm < LABEL_LIMITS.heightMinMm || config.contentLengthMm > heightMm)) {
    throw new LabelLayoutError("INVALID_CONFIG", "La zone imprimée doit mesurer au moins 50 mm et rester dans la longueur du papier.");
  }
}

export function labelFrame(config: Pick<LabelConfig, "widthMm" | "heightMm" | "orientation">): LabelFrame {
  const orientation = config.orientation ?? "ROTATE_90";
  const acrossOverhangMm = Math.max(0, (config.widthMm - PRINTHEAD_MAX_MM) / 2);
  if (orientation === "LANDSCAPE") {
    return { orientation, rotation: 0, pageWidthMm: config.heightMm, pageHeightMm: config.widthMm, readingWidthMm: config.heightMm, readingHeightMm: config.widthMm, acrossAxis: "y", acrossOverhangMm };
  }
  if (orientation === "ROTATE_90") {
    return { orientation, rotation: 90, pageWidthMm: config.widthMm, pageHeightMm: config.heightMm, readingWidthMm: config.heightMm, readingHeightMm: config.widthMm, acrossAxis: "y", acrossOverhangMm };
  }
  return { orientation, rotation: 0, pageWidthMm: config.widthMm, pageHeightMm: config.heightMm, readingWidthMm: config.widthMm, readingHeightMm: config.heightMm, acrossAxis: "x", acrossOverhangMm };
}

/* ------------------------------------------------------------ text metrics */

/** Arial Bold / Helvetica Bold advance widths (1/1000 em), ASCII 32–126. */
const ARIAL_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, // space … /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0–9
  333, 333, 584, 584, 584, 611, 975, // : ; < = > ? @
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // A–Z
  333, 278, 333, 584, 556, 333, // [ \ ] ^ _ `
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, // a–z
  389, 280, 389, 584, // { | } ~
];
const SPECIAL_WIDTHS: Record<string, number> = { "—": 1000, "–": 556, "×": 584, "°": 400, "«": 556, "»": 556, "’": 278, "·": 278, "€": 556, " ": 278 };

function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code >= 32 && code <= 126) return ARIAL_BOLD[code - 32];
  if (SPECIAL_WIDTHS[ch] !== undefined) return SPECIAL_WIDTHS[ch];
  const base = ch.normalize("NFD").charAt(0);
  if (base !== ch && base.codePointAt(0)! >= 32 && base.codePointAt(0)! <= 126) return ARIAL_BOLD[base.codePointAt(0)! - 32];
  return 1000; // unknown glyph: assume the widest
}

/** Width (dots) of a text in Arial Bold at a font size, with a 2 % safety for rasterization. */
export function estimateTextWidth(text: string, fontHeight: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch);
  return Math.ceil((units * fontHeight * 1.02) / 1000);
}

/** Largest font size (dots) at which `text` fits `width` dots. */
function fontForWidth(text: string, width: number): number {
  const at100 = estimateTextWidth(text, 1000);
  return at100 === 0 ? Number.MAX_SAFE_INTEGER : Math.floor((width * 1000) / at100);
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

/** Even character chunks (identifiers without spaces: PN, serials). */
function chunkLines(text: string, count: number): string[] {
  const chars = [...text];
  const per = Math.ceil(chars.length / count);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += per) out.push(chars.slice(i, i + per).join(""));
  return out;
}

const widestOf = (lines: string[]) => Math.max(1, ...lines.map((l) => estimateTextWidth(l, 1000)));

/**
 * Break at spaces into exactly `count` lines, minimizing the widest line.
 * Never starts a line with « : » or « — », never separates a number from its unit.
 * Null when the text has fewer words than lines.
 */
function wordLines(text: string, count: number): string[] | null {
  const words: string[] = [];
  for (const token of text.split(" ").filter(Boolean)) {
    const prev = words.length - 1;
    if (prev >= 0 && (/^[:;!?—]$/.test(token) || /^\d+$/.test(words[prev]))) words[prev] = `${words[prev]} ${token}`;
    else words.push(token);
  }
  if (words.length < count) return null;
  let best: string[] | null = null;
  const search = (start: number, left: number, acc: string[]) => {
    if (left === 1) {
      const lines = [...acc, words.slice(start).join(" ")];
      if (!best || widestOf(lines) < widestOf(best)) best = lines;
      return;
    }
    for (let end = start + 1; end <= words.length - (left - 1); end++) search(end, left - 1, [...acc, words.slice(start, end).join(" ")]);
  };
  search(0, count, []);
  return best;
}

/**
 * Fit text in `maxWidth` dots: font from `preferred` down to `min`, then wrap
 * onto up to `maxLines` lines — at spaces first; only text that still cannot fit
 * (a long identifier) is cut into even chunks. Never truncates: throws instead.
 */
export function fitText(text: string, maxWidth: number, preferred: number, min: number, maxLines: number): FittedText {
  for (const split of [(n: number) => (n === 1 ? [text] : wordLines(text, n)), (n: number) => chunkLines(text, n)]) {
    for (let count = 1; count <= maxLines; count++) {
      const lines = split(count);
      if (!lines) continue;
      const fontHeight = Math.min(preferred, ...lines.map((l) => fontForWidth(l, maxWidth)));
      if (fontHeight >= min) return { lines, fontHeight };
    }
  }
  throw new LabelLayoutError("TEXT_TOO_LONG", `Texte trop long pour l'étiquette : « ${text} ». Agrandir l'étiquette.`);
}

export const REPRINT_MARKER = "RÉIMPRESSION";
export const TEST_MARKER = "TEST — NE PAS UTILISER";
/** Deliberately not a valid GALIA payload, so a scanned test label is rejected by the app. */
export const TEST_QR_DATA = "TEST_NE_PAS_UTILISER";

/* ------------------------------------------------------------- builder */

class Builder {
  readonly dotsPerMm: number;
  readonly frame: LabelFrame;
  readonly W: number;
  readonly H: number;
  /** Margins of the reading frame: left/right and top/bottom. */
  readonly mx: number;
  readonly my: number;
  readonly innerW: number;
  readonly elements: LayoutElement[] = [];

  constructor(
    readonly config: LabelConfig,
    /** Size factor (1 = nominal sizes designed for a 150 × 100 mm frame). */
    readonly k: number,
    extraMarginMm = 0,
  ) {
    this.dotsPerMm = DOTS_PER_MM[config.dpi];
    this.frame = labelFrame(config);
    this.W = this.mm(this.frame.readingWidthMm);
    this.H = this.mm(this.frame.readingHeightMm);
    const across = this.mm(MARGIN_MM + this.frame.acrossOverhangMm + extraMarginMm);
    const feed = this.mm(MARGIN_MM + extraMarginMm);
    this.mx = this.frame.acrossAxis === "x" ? across : feed;
    this.my = this.frame.acrossAxis === "y" ? across : feed;
    this.innerW = this.W - 2 * this.mx;
  }

  mm(value: number): number {
    return Math.round(value * this.dotsPerMm);
  }

  /** Font size: nominal millimetres × size factor, never below `minMm`. */
  font(nominalMm: number, minMm = MIN_FONT_MM): number {
    return Math.max(this.mm(minMm), this.mm(nominalMm * this.k));
  }

  /** Spacing that grows with the label, never below `minMm`. */
  gap(nominalMm: number, minMm = 0.8): number {
    return Math.max(this.mm(minMm), this.mm(nominalMm * this.k));
  }

  /** Gap between wrapped lines: leaves room for accents and descenders. */
  lineGap(fontHeight: number): number {
    return Math.max(this.mm(0.6), Math.round(fontHeight * 0.16));
  }

  /** QR module: 0.75 mm × size factor, between 0.5 and 1.0 mm, in whole printer dots. */
  qrModuleDots(): number {
    const mmPerModule = Math.min(1, Math.max(0.5, 0.75 * this.k));
    return Math.max(4, Math.round(mmPerModule * this.dotsPerMm));
  }

  text(role: string, x: number, y: number, width: number, fontHeight: number, text: string, align: TextElement["align"], reverse = false) {
    this.elements.push({ type: "text", role, x, y, width, fontHeight, text, align, reverse });
  }

  /** Fitted (possibly wrapped) text block; returns the y below it. */
  block(role: string, text: string, x: number, y: number, width: number, preferred: number, min: number, maxLines: number, align: TextElement["align"], reverse = false): number {
    const fit = fitText(text, width, preferred, min, maxLines);
    const gap = this.lineGap(fit.fontHeight);
    fit.lines.forEach((line, i) => this.text(fit.lines.length > 1 ? `${role}-${i + 1}` : role, x, y + i * (fit.fontHeight + gap), width, fit.fontHeight, line, align, reverse));
    return y + fit.lines.length * fit.fontHeight + (fit.lines.length - 1) * gap;
  }

  /** Caption + value pair; returns the y below it. */
  field(role: string, caption: string, value: string, x: number, y: number, width: number, nominalMm: number, maxLines: number): number {
    const capH = this.font(3);
    this.text(`${role}-caption`, x, y, width, capH, caption, "L");
    return this.block(role, value, x, y + capH + this.lineGap(capH), width, this.font(nominalMm, 3), this.mm(3), maxLines, "L");
  }

  rect(role: string, x: number, y: number, width: number, height: number, thickness: number, filled: boolean) {
    this.elements.push({ type: "rect", role, x, y, width, height, thickness, filled });
  }

  /** Horizontal rule across the inner width; returns the y below it. */
  rule(role: string, y: number): number {
    const t = Math.max(4, this.mm(0.5));
    this.rect(role, this.mx, y, this.innerW, t, 0, true);
    return y + t;
  }

  /**
   * Header: very large result on the left (framed OK / reversed NOT OK), the
   * finalizing operator in the TOP-RIGHT corner. Returns the y below it.
   */
  resultHeader(result: "OK" | "NOT_OK", operator: string): number {
    const y0 = this.my;
    const boxH = Math.max(this.mm(11), this.mm(20 * this.k));
    const capH = this.font(3);
    if (this.innerW < this.mm(70)) {
      // Narrow reading frame: operator first (still top-right), result full width below.
      this.text("operator-caption", this.mx, y0, this.innerW, capH, "OPÉRATEUR", "R");
      const y = this.block("operator", operator, this.mx, y0 + capH + this.lineGap(capH), this.innerW, this.font(7, 3.5), this.mm(3), 3, "R") + this.gap(1.2);
      this.resultBox(result, this.mx, y, this.innerW, boxH);
      return y + boxH;
    }
    const boxW = Math.round(this.innerW * (result === "OK" ? 0.4 : 0.55));
    this.resultBox(result, this.mx, y0, boxW, boxH);
    const rightX = this.mx + boxW + this.mm(4);
    const rightW = this.W - this.mx - rightX;
    this.text("operator-caption", rightX, y0, rightW, capH, "OPÉRATEUR", "R");
    const bottom = this.block("operator", operator, rightX, y0 + capH + this.lineGap(capH), rightW, this.font(8, 3.5), this.mm(3), 3, "R");
    return Math.max(y0 + boxH, bottom);
  }

  /** Framed "OK" or reversed (white on black) "NOT OK" — unmistakable in black & white. */
  resultBox(result: "OK" | "NOT_OK", x: number, y: number, w: number, h: number) {
    if (result === "OK") {
      const t = Math.max(this.mm(1), Math.min(this.mm(2), Math.round(h * 0.07)));
      this.rect("result-frame", x, y, w, h, t, false);
      const pref = Math.round(h * 0.92);
      const fit = fitText("OK", w - 2 * t - this.mm(4), pref, Math.min(pref, this.mm(7)), 1);
      this.text("result", x, y + Math.floor((h - fit.fontHeight) / 2), w, fit.fontHeight, "OK", "C");
    } else {
      this.rect("result-block", x, y, w, h, 0, true);
      const pref = Math.round(h * 0.84);
      const fit = fitText("NOT OK", w - this.mm(6), pref, Math.min(pref, this.mm(5)), 1);
      this.text("result", x, y + Math.floor((h - fit.fontHeight) / 2), w, fit.fontHeight, "NOT OK", "C", true);
    }
  }

  /** Expected / scanned / conforming / nonconforming, as a grid of framed cells. Returns the y below it. */
  figures(f: LabelFigures, x: number, y: number, w: number): number {
    const cells: [string, string, number][] = [
      ["figure-expected", "ATTENDU", f.expected],
      ["figure-scanned", "SCANNÉ", f.distinct],
      ["figure-conforming", "CONFORME", f.conforming],
      ["figure-nonconforming", "NON CONFORME", f.nonconforming],
    ];
    const between = this.gap(1.5, 1);
    const pad = this.gap(1, 0.8);
    // Four cells in one row only when the longest caption still fits a cell at the minimum size.
    const widestCaption = estimateTextWidth("NON CONFORME", this.mm(MIN_FONT_MM)) + 2 * pad;
    const cols = Math.floor((w - 3 * between) / 4) >= widestCaption ? 4 : 2;
    const cellW = Math.floor((w - (cols - 1) * between) / cols);
    const t = Math.max(3, this.mm(0.35));
    const capH = this.font(3);
    const valueH = this.font(12, 3.5);
    const inner = cellW - 2 * pad;
    const rowH = pad + capH + this.lineGap(capH) + valueH + pad;
    for (const [i, [role, caption, value]] of cells.entries()) {
      const cx = x + (i % cols) * (cellW + between);
      const cy = y + Math.floor(i / cols) * (rowH + between);
      this.rect(`${role}-frame`, cx, cy, cellW, rowH, t, false);
      const cap = fitText(caption, inner, capH, this.mm(MIN_FONT_MM), 1);
      this.text(`${role}-caption`, cx + pad, cy + pad, inner, cap.fontHeight, caption, "L");
      const val = fitText(String(value), inner, valueH, this.mm(3), 1);
      this.text(role, cx + pad, cy + pad + capH + this.lineGap(capH), inner, val.fontHeight, String(value), "L");
    }
    const rows = Math.ceil(cells.length / cols);
    return y + rows * rowH + (rows - 1) * between;
  }

  /** Framed issue summary: one line per issue, all at one size, never truncated. Returns the y below it. */
  issues(lines: string[], x: number, y: number, w: number, cols: number): number {
    if (lines.length === 0) return y;
    const pad = this.gap(1.2, 1);
    const t = Math.max(4, this.mm(0.5));
    const between = this.mm(4);
    const colW = Math.floor((w - 2 * pad - (cols - 1) * between) / cols);
    // The smallest size any line needs, so no issue looks less important.
    const pref = Math.min(...lines.map((l) => fitText(l, colW, this.font(6, 3), this.mm(MIN_FONT_MM), 2).fontHeight));
    const rows = Math.ceil(lines.length / cols);
    let cy = y + pad;
    for (let r = 0; r < rows; r++) {
      let rowBottom = cy;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= lines.length) break;
        const bottom = this.block(`issue-${i + 1}`, lines[i], x + pad + c * (colW + between), cy, colW, pref, this.mm(MIN_FONT_MM), 2, "L");
        rowBottom = Math.max(rowBottom, bottom);
      }
      cy = rowBottom + this.lineGap(pref);
    }
    const bottom = cy - this.lineGap(pref) + pad;
    this.rect("issues-frame", x, y, w, bottom - y, t, false);
    return bottom;
  }

  /** Footer pinned to the bottom: finalization time (left), RÉIMPRESSION marker (right). Returns its top. */
  footer(finalizedAt: string, reprint: boolean): number {
    const h = this.font(3);
    const pad = this.mm(1);
    const markH = Math.max(h, this.font(4.2, 3));
    const markW = reprint ? Math.min(Math.floor(this.innerW * 0.45), estimateTextWidth(REPRINT_MARKER, markH) + 2 * pad + this.mm(1)) : 0;
    const textW = reprint ? this.innerW - markW - this.mm(3) : this.innerW;
    const label = `Fin du contrôle : ${finalizedAt} (Tunis)`;
    const fit = fitText(label, textW, h, this.mm(MIN_FONT_MM), 2);
    const gap = this.lineGap(fit.fontHeight);
    const textH = fit.lines.length * fit.fontHeight + (fit.lines.length - 1) * gap;
    const rowH = Math.max(textH, reprint ? markH + 2 * pad : 0);
    const top = this.H - this.my - rowH;
    if (reprint) {
      const mark = fitText(REPRINT_MARKER, markW - 2 * pad, markH, this.mm(MIN_FONT_MM), 1);
      const mx = this.W - this.mx - markW;
      this.rect("reprint-background", mx, top, markW, rowH, 0, true);
      this.text("reprint", mx + pad, top + Math.floor((rowH - mark.fontHeight) / 2), markW - 2 * pad, mark.fontHeight, REPRINT_MARKER, "C", true);
    }
    const ty = top + Math.floor((rowH - textH) / 2);
    fit.lines.forEach((line, i) => this.text(fit.lines.length > 1 ? `finalized-at-${i + 1}` : "finalized-at", this.mx, ty + i * (fit.fontHeight + gap), textW, fit.fontHeight, line, "L"));
    return top;
  }

  ensureFits(bottom: number, limit = this.H - this.my) {
    if (bottom > limit) {
      throw new LabelLayoutError("LABEL_TOO_SMALL", "Contenu plus grand que l'étiquette.");
    }
  }

  layout(template: LabelContent["template"]): LabelLayout {
    return {
      template,
      widthDots: this.W,
      heightDots: this.H,
      pageWidthDots: this.mm(this.frame.pageWidthMm),
      pageHeightDots: this.mm(this.frame.pageHeightMm),
      frame: this.frame,
      dpi: this.config.dpi,
      dotsPerMm: this.dotsPerMm,
      marginDots: this.mx,
      marginYDots: this.my,
      accentMode: this.config.accentMode,
      fitScale: this.k,
      elements: this.elements,
    };
  }
}

function pushQr(b: Builder, role: string, x: number, y: number, data: string): number {
  const mag = b.qrModuleDots();
  const modules = qrModules(data.length);
  const quiet = 4 * mag;
  b.elements.push({ type: "qr", role, x: x + quiet, y: y + quiet, magnification: mag, modules, quietZone: quiet, data });
  return modules * mag + 2 * quiet;
}

function qrBlockSize(b: Builder, data: string): number {
  const mag = b.qrModuleDots();
  return qrModules(data.length) * mag + 8 * mag;
}

/** PN + box serial: side by side on wide labels, stacked otherwise. Returns the y below. */
function identity(b: Builder, c: { partNumber: string; boxSerial: string }, x: number, y: number, w: number): number {
  const between = b.mm(4);
  if (w >= b.mm(88)) {
    const pnW = Math.floor((w - between) * 0.6);
    const a = b.field("part-number", "PN", c.partNumber, x, y, pnW, 9.5, 2);
    const s = b.field("box-serial", "N° BOÎTE", c.boxSerial, x + pnW + between, y, w - pnW - between, 9.5, 2);
    return Math.max(a, s);
  }
  const a = b.field("part-number", "PN", c.partNumber, x, y, w, 9.5, 2);
  return b.field("box-serial", "N° BOÎTE", c.boxSerial, x, a + b.gap(1.5), w, 9.5, 2);
}

function buildOk(c: OkContent, b: Builder): void {
  if (!isQrSafePayload(c.galiaPayload)) {
    throw new LabelLayoutError("INVALID_CONFIG", "Contenu QR refusé : seuls A–Z, 0–9 et « _ » sont autorisés.");
  }
  if (b.W >= b.H * 3) return buildWideResult(c, b);
  const section = b.gap(2);
  let y = b.resultHeader("OK", c.operator) + section;
  y = b.rule("header-rule", y) + section;
  const footerTop = b.footer(c.finalizedAt, c.reprint);

  const qr = qrBlockSize(b, c.galiaPayload);
  const colGap = b.mm(4);
  let bottom: number;
  if (b.innerW - qr - colGap >= b.mm(55)) {
    // QR (exact GALIA payload) on the right, box data on the left.
    const qrX = b.W - b.mx - qr;
    pushQr(b, "galia-qr", qrX, y, c.galiaPayload);
    const dataW = qrX - colGap - b.mx;
    let dy = identity(b, c, b.mx, y, dataW) + section;
    dy = b.figures(c.figures, b.mx, dy, dataW) + section;
    bottom = b.issues(c.figures.lines, b.mx, Math.max(dy, y + qr + section), b.innerW, 1);
  } else {
    // Narrow reading frame: data full width, then the QR on the right with the summary beside it.
    let dy = identity(b, c, b.mx, y, b.innerW) + section;
    dy = b.figures(c.figures, b.mx, dy, b.innerW) + section;
    const qrX = b.W - b.mx - qr;
    pushQr(b, "galia-qr", qrX, dy, c.galiaPayload);
    const sideW = qrX - colGap - b.mx;
    const summary = sideW >= b.mm(28) ? b.issues(c.figures.lines, b.mx, dy, sideW, 1) : b.issues(c.figures.lines, b.mx, dy + qr + section, b.innerW, 1);
    bottom = Math.max(summary, dy + qr);
  }
  b.ensureFits(bottom, footerTop - b.gap(1.5));
}

function buildNotOk(c: NotOkContent, b: Builder): void {
  // No QR code and no barcode of any kind on a NOT OK label.
  if (b.W >= b.H * 3) return buildWideResult(c, b);
  const section = b.gap(2);
  let y = b.resultHeader("NOT_OK", c.operator) + section;
  y = b.rule("header-rule", y) + section;
  const footerTop = b.footer(c.finalizedAt, c.reprint);
  y = identity(b, c, b.mx, y, b.innerW) + section;
  y = b.figures(c.figures, b.mx, y, b.innerW) + section;
  const cols = c.figures.lines.length >= 3 && b.innerW >= b.mm(88) ? 2 : 1;
  const bottom = b.issues(c.figures.lines, b.mx, y, b.innerW, cols);
  b.ensureFits(bottom, footerTop - b.gap(1.5));
}

/** Long stock (e.g. 110 × 400): a full-height result beside the information,
 * instead of stretching shallow rows into mostly empty boxes. */
function buildWideResult(c: OkContent | NotOkContent, b: Builder): void {
  const footerTop = b.footer(c.finalizedAt, c.reprint);
  const gap = b.gap(1.5);
  const resultW = Math.floor(b.innerW * (c.template === "OK" ? 0.23 : 0.38));
  b.resultBox(c.template, b.mx, b.my, resultW, footerTop - gap - b.my);
  const x = b.mx + resultW + b.mm(4);
  const width = b.W - b.mx - x;
  const caption = b.font(3);
  b.text("operator-caption", x, b.my, width, caption, "OPÉRATEUR", "R");
  let y = b.block("operator", c.operator, x, b.my + caption + b.lineGap(caption), width, b.font(8, 3.5), b.mm(3), 3, "R") + gap;
  b.rect("wide-header-rule", x, y, width, b.mm(0.5), 0, true);
  y += b.mm(0.5) + gap;
  const qr = c.template === "OK" ? qrBlockSize(b, c.galiaPayload) : 0;
  const dataW = width - (qr ? qr + b.mm(4) : 0);
  if (qr && c.template === "OK") pushQr(b, "galia-qr", b.W - b.mx - qr, y, c.galiaPayload);
  let bottom = identity(b, c, x, y, dataW) + gap;
  bottom = b.figures(c.figures, x, bottom, dataW) + gap;
  bottom = b.issues(c.figures.lines, x, Math.max(bottom, y + qr + (qr ? gap : 0)), width, c.figures.lines.length >= 3 ? 2 : 1);
  b.ensureFits(bottom, footerTop - gap);
}

/** Width of the TEST scale bar (mm) for a reading frame: 50 mm when it fits. */
export function testRulerMm(config: Pick<LabelConfig, "widthMm" | "heightMm" | "orientation">): number {
  const f = labelFrame(config);
  const marginX = (f.acrossAxis === "x" ? f.acrossOverhangMm : 0) + MARGIN_MM + 1.5;
  return Math.min(50, Math.floor((f.readingWidthMm - 2 * marginX) / 10) * 10);
}

function buildTest(c: TestContent, b: Builder): void {
  const cfg = b.config;
  const frame = b.frame;
  const stockLengthMm = c.stockLengthMm ?? cfg.heightMm;
  const stockFrame = labelFrame({ ...cfg, heightMm: stockLengthMm });
  const thin = Math.max(3, b.mm(0.3));
  // Edge guide: 1 mm inside the printable band (the roll edge, or the printhead
  // edge when the roll is wider than 104 mm). Inner guide: the safe content margin.
  // A guide cut off or misplaced shows a wrong size, scale or position.
  const overhang = frame.acrossOverhangMm;
  const ex = b.mm(1 + (frame.acrossAxis === "x" ? overhang : 0));
  const ey = b.mm(1 + (frame.acrossAxis === "y" ? overhang : 0));
  b.rect("guide-edge", ex, ey, b.W - 2 * ex, b.H - 2 * ey, thin, false);
  const gx = b.mm(MARGIN_MM + (frame.acrossAxis === "x" ? overhang : 0));
  const gy = b.mm(MARGIN_MM + (frame.acrossAxis === "y" ? overhang : 0));
  b.rect("guide-margin", gx, gy, b.W - 2 * gx, b.H - 2 * gy, thin, false);

  // Header: "HAUT" arrow (top of the reading direction) + operator (right).
  const y0 = b.my;
  const arrowH = b.font(5, 3);
  const arrowW = Math.round(arrowH * 0.9);
  b.elements.push({ type: "poly", role: "up-arrow", points: [[b.mx + Math.round(arrowW / 2), y0], [b.mx + arrowW, y0 + arrowH], [b.mx, y0 + arrowH]] });
  const opW = Math.floor(b.innerW * 0.36);
  const upX = b.mx + arrowW + b.mm(2);
  const upW = b.W - b.mx - opW - b.mm(3) - upX;
  const upBottom = b.block("up-marker", "HAUT — lire l'étiquette dans ce sens", upX, y0, upW, b.font(4.5), b.mm(MIN_FONT_MM), 2, "L");
  const capH = b.font(3);
  b.text("operator-caption", b.W - b.mx - opW, y0, opW, capH, "OPÉRATEUR", "R");
  const opBottom = b.block("operator", c.operator, b.W - b.mx - opW, y0 + capH + b.lineGap(capH), opW, b.font(5, 3), b.mm(MIN_FONT_MM), 3, "R");
  let y = Math.max(y0 + arrowH, upBottom, opBottom) + b.gap(2);

  // Reversed TEST block.
  const pad = b.gap(1.5, 1.2);
  const fit = fitText("TEST", b.innerW - 2 * pad, b.font(22, 6), b.mm(6), 1);
  const warning = fitText("— NE PAS UTILISER", b.innerW - 2 * pad, b.font(5.5, 3), b.mm(3), 1);
  const lineGap = b.lineGap(fit.fontHeight);
  const blockH = fit.fontHeight + lineGap + warning.fontHeight + 2 * pad;
  b.rect("test-block", b.mx, y, b.innerW, blockH, 0, true);
  b.text("test-marker-1", b.mx, y + pad, b.innerW, fit.fontHeight, "TEST", "C", true);
  b.text("test-marker-2", b.mx, y + pad + fit.fontHeight + lineGap, b.innerW, warning.fontHeight, "— NE PAS UTILISER", "C", true);
  y += blockH + b.gap(2);

  // Information lines (left) + sample QR (right).
  const qr = qrBlockSize(b, TEST_QR_DATA);
  const linesW = b.innerW - qr - b.mm(4);
  if (linesW < b.mm(30)) throw new LabelLayoutError("LABEL_TOO_SMALL", "Étiquette trop petite pour l'étiquette TEST.");
  pushQr(b, "test-qr", b.W - b.mx - qr, y, TEST_QR_DATA);
  const page =
    frame.orientation === "LANDSCAPE"
      ? `Page : ${stockFrame.pageWidthMm} × ${stockFrame.pageHeightMm} mm paysage — tournée une fois par le pilote`
      : frame.orientation === "ROTATE_90"
        ? `Page : ${stockFrame.pageWidthMm} × ${stockFrame.pageHeightMm} mm portrait — contenu tourné par l'application`
        : `Page : ${stockFrame.pageWidthMm} × ${stockFrame.pageHeightMm} mm portrait — sans rotation`;
  const lines = [
    `Poste : ${c.workstationName}`,
    `Étiquette : ${cfg.widthMm} mm (largeur, travers tête) × ${stockLengthMm} mm (longueur, avance)`,
    page,
    cfg.accentMode === "UTF8" ? "Texte : ABCDEFGHIJ 0123456789 É È À Ç Ô Ù" : "Texte : ABCDEFGHIJ 0123456789 (ASCII)",
    `Modèle : ${TEMPLATE_VERSION}`,
  ];
  let ly = y;
  const lineH = Math.min(...lines.map((l) => fitText(l, linesW, b.font(4.2), b.mm(MIN_FONT_MM), 3).fontHeight));
  for (const [i, line] of lines.entries()) {
    ly = b.block(`test-line-${i + 1}`, line, b.mx, ly, linesW, lineH, b.mm(MIN_FONT_MM), 3, "L") + b.lineGap(lineH);
  }
  y = Math.max(ly, y + qr) + b.gap(1.5);

  // Scale check: a bar of a whole number of centimetres (50 mm when it fits),
  // measured with a ruler it must match exactly at 100 % / actual size.
  const rulerMm = Math.min(50, Math.floor(b.innerW / b.dotsPerMm / 10) * 10);
  y = b.block("scale-caption", `Barre : ${rulerMm} mm exactement (échelle 100 %)`, b.mx, y, b.innerW, lineH, b.mm(MIN_FONT_MM), 2, "L") + b.mm(1);
  b.rect("scale-ruler", b.mx, y + b.mm(1.5), b.mm(rulerMm), b.mm(1.5), 0, true);
  for (let cm = 0; cm <= rulerMm / 10; cm++) {
    b.rect(`scale-tick-${cm}`, b.mx + b.mm(cm * 10) - (cm === rulerMm / 10 ? b.mm(0.4) : 0), y, b.mm(0.4), b.mm(4.5), 0, true);
  }
  b.ensureFits(y + b.mm(4.5));
}

/* ----------------------------------------------------------- validation */

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
  if (el.type === "poly") {
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    return { role: el.role, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  const size = el.modules * el.magnification;
  return { role: el.role, x: el.x - el.quietZone, y: el.y - el.quietZone, w: size + 2 * el.quietZone, h: size + 2 * el.quietZone };
}

/** Visible width a text element really needs (for overlap checks of aligned text). */
function inkBounds(el: TextElement): Box2D {
  const w = Math.min(el.width, estimateTextWidth(el.text, el.fontHeight));
  const x = el.align === "L" ? el.x : el.align === "R" ? el.x + el.width - w : el.x + Math.floor((el.width - w) / 2);
  return { role: el.role, x, y: el.y, w, h: el.fontHeight };
}

function intersects(a: Box2D, b: Box2D): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Validate a layout: every element inside its margins (TEST guides: inside the
 * printable band), every text fitting its box, no text/QR/arrow overlapping.
 */
export function validateLayout(layout: LabelLayout): void {
  const f = layout.frame;
  const band = (axis: "x" | "y") => Math.round(((f.acrossAxis === axis ? f.acrossOverhangMm : 0) + 1) * layout.dotsPerMm);
  for (const el of layout.elements) {
    const bx = boundsOf(el);
    const guide = el.type === "rect" && el.role.startsWith("guide-");
    const minX = guide ? band("x") : layout.marginDots;
    const minY = guide ? band("y") : layout.marginYDots;
    if (bx.x < minX || bx.y < minY || bx.x + bx.w > layout.widthDots - minX || bx.y + bx.h > layout.heightDots - minY) {
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
  const solid = layout.elements.filter((e): e is TextElement | QrElement | PolyElement => e.type !== "rect");
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

/**
 * Worst-case content used to prove the configured stock can hold every label:
 * longest PN / serial / operator, 3-digit quantities and every issue line at once.
 */
export function worstCaseContents(): LabelContent[] {
  const pn = "L".padEnd(40, "8");
  const op = "W".repeat(32);
  const serial = "9".repeat(30);
  const payload = `P${pn}_Q999_S${serial}`;
  const at = "31/12/2026 23:59:59";
  const lines = [
    "MANQUANT : 999 pièces",
    "EXCÉDENT : 999 pièces",
    "RÉFÉRENCE DIFFÉRENTE : 999 pièces",
    "SÉRIE DÉJÀ UTILISÉE : 999 pièces",
    "SCAN EN DOUBLE : 999 tentatives",
    "FORMAT INVALIDE : 999 tentatives",
  ];
  return [
    { template: "OK", operator: op, partNumber: pn, boxSerial: serial, galiaPayload: payload, figures: { expected: 999, distinct: 999, conforming: 999, nonconforming: 0, lines: ["CONFORME — Quantité et références vérifiées"] }, finalizedAt: at, reprint: true },
    { template: "NOT_OK", operator: op, partNumber: pn, boxSerial: serial, figures: { expected: 999, distinct: 1998, conforming: 999, nonconforming: 999, lines }, finalizedAt: at, reprint: true },
    { template: "TEST", operator: op, workstationName: "Z".repeat(60) },
  ];
}

function orientationLabel(frame: LabelFrame): string {
  return frame.orientation === "LANDSCAPE" ? "page paysage" : frame.rotation === 90 ? "contenu tourné de 90°" : "sans rotation";
}

/** Size factors searched: from the smallest legible to very large. */
const SCALE_MIN = 0.4;
const SCALE_MAX = 3.5;

function attempt(content: LabelContent, config: LabelConfig, k: number): LabelLayout {
  const b = new Builder(config, k, content.template === "TEST" ? 1.5 : 0);
  if (content.template === "TEST") buildTest(content, b);
  else if (content.template === "OK") buildOk(content, b);
  else buildNotOk(content, b);
  const layout = b.layout(content.template);
  validateLayout(layout);
  return layout;
}

/**
 * Build and validate the layout for a content + label configuration. The
 * largest size factor that fits is searched, so the label is filled with the
 * biggest legible text; content that does not fit even at the minimum sizes
 * raises a LabelLayoutError (never clipped, never truncated).
 */
export function buildLayout(content: LabelContent, config: LabelConfig): LabelLayout {
  validateConfig(config);
  // Lay out the chosen print area at its real size, then position it on the
  // complete sheet. Text and square QR modules are never scaled by placement.
  if (config.contentLengthMm != null && config.contentLengthMm < config.heightMm) {
    const length = config.contentLengthMm;
    const layout = buildLayout(content.template === "TEST" ? { ...content, stockLengthMm: config.heightMm } : content, { ...config, heightMm: length, contentLengthMm: null });
    const frame = labelFrame(config);
    const free = Math.round((config.heightMm - length) * layout.dotsPerMm);
    const offset = config.contentPosition === "TOP" ? 0 : config.contentPosition === "BOTTOM" ? free : Math.floor(free / 2);
    const dx = frame.orientation === "NONE" ? 0 : offset;
    const dy = frame.orientation === "NONE" ? offset : 0;
    const placed: LabelLayout = { ...layout, frame, widthDots: Math.round(frame.readingWidthMm * layout.dotsPerMm), heightDots: Math.round(frame.readingHeightMm * layout.dotsPerMm),
      pageWidthDots: Math.round(frame.pageWidthMm * layout.dotsPerMm), pageHeightDots: Math.round(frame.pageHeightMm * layout.dotsPerMm),
      elements: layout.elements.map((el) => el.type === "poly" ? { ...el, points: el.points.map(([x, y]): [number, number] => [x + dx, y + dy]) } : { ...el, x: el.x + dx, y: el.y + dy }) };
    validateLayout(placed);
    return placed;
  }
  let last: LabelLayoutError | null = null;
  const tryScale = (k: number): LabelLayout | null => {
    try {
      return attempt(content, config, k);
    } catch (e) {
      if (!(e instanceof LabelLayoutError) || e.code === "INVALID_CONFIG") throw e;
      last = e;
      return null;
    }
  };
  let best = tryScale(SCALE_MIN);
  if (!best) {
    const frame = labelFrame(config);
    const reason = (last as LabelLayoutError | null)?.message ?? "";
    throw new LabelLayoutError(
      "LABEL_TOO_SMALL",
      `Contenu trop grand pour l'étiquette ${config.widthMm} × ${config.heightMm} mm (${orientationLabel(frame)}), même réduit au minimum lisible : ${reason} Agrandir l'étiquette ou changer l'orientation — rien n'a été imprimé.`,
    );
  }
  const top = tryScale(SCALE_MAX);
  if (top) return top;
  let lo = SCALE_MIN;
  let hi = SCALE_MAX;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const layout = tryScale(mid);
    if (layout) {
      best = layout;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}
