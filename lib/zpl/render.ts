import { toAsciiVocabulary } from "./encode";
import { buildLayout, estimateTextWidth, type LabelConfig, type LabelContent, type LabelLayout } from "./layout";

function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface SvgOptions {
  /** Real QR module matrix (server-side); without it a placeholder square is drawn. */
  qrMatrix?: (data: string) => boolean[][];
  /**
   * Print rendering: the SVG is the PAGE (stock width × length in mm) and the
   * reading frame is rotated onto it when the layout says so. Omitted = on-screen
   * preview of the reading frame (not rotated) with an outline.
   */
  physical?: { widthMm: number; heightMm: number };
  /** On-screen picture of the printed page (rotated like the print, no mm size). */
  page?: boolean;
}

/**
 * SVG rendering of the label layout. With `physical`, the SVG is sized in
 * millimetres and is exactly what the browser prints (black on white, 1 unit =
 * 1 printer dot at 203 dpi). With ROTATE_90 the landscape content is turned
 * 90° ONCE here (exact quarter turn: QR modules stay on whole dots); with
 * LANDSCAPE the page itself is landscape and the Windows driver turns it.
 * Text is Arial Bold; textLength equals the measured Arial Bold width (so the
 * glyphs keep their shape) and caps it to the validated box if another font
 * were substituted.
 */
export function renderSvg(layout: LabelLayout, options: SvgOptions = {}): string {
  const physical = options.physical;
  const asPage = !!physical || options.page === true;
  const rotate = asPage && layout.frame.rotation === 90;
  const vw = asPage ? layout.pageWidthDots : layout.widthDots;
  const vh = asPage ? layout.pageHeightDots : layout.heightDots;
  if (physical && (physical.widthMm !== layout.frame.pageWidthMm || physical.heightMm !== layout.frame.pageHeightMm)) {
    throw new Error("Taille physique différente de la mise en page.");
  }
  const size = physical ? ` width="${physical.widthMm}mm" height="${physical.heightMm}mm"` : "";
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}"${size} role="img" aria-label="Étiquette" data-template="${layout.template}" data-rotation="${rotate ? 90 : 0}">`,
    `<rect x="0" y="0" width="${vw}" height="${vh}" fill="#fff"${physical ? "" : ' stroke="#94a3b8" stroke-width="2"'}/>`,
    // translate(W 0) rotate(90): reading (x, y) → page (W − y, x). Reading left = page top = leading edge.
    rotate ? `<g transform="translate(${vw} 0) rotate(90)">` : "<g>",
  ];
  for (const el of layout.elements) {
    if (el.type === "rect") {
      if (el.filled) {
        parts.push(`<rect data-role="${el.role}" x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="#000" shape-rendering="crispEdges"/>`);
      } else {
        const t = el.thickness;
        parts.push(`<rect data-role="${el.role}" x="${el.x + t / 2}" y="${el.y + t / 2}" width="${el.width - t}" height="${el.height - t}" fill="none" stroke="#000" stroke-width="${t}" shape-rendering="crispEdges"/>`);
      }
    } else if (el.type === "poly") {
      parts.push(`<polygon data-role="${el.role}" points="${el.points.map(([x, y]) => `${x},${y}`).join(" ")}" fill="#000"/>`);
    } else if (el.type === "text") {
      const shown = layout.accentMode === "ASCII" ? toAsciiVocabulary(el.text) : el.text;
      const anchor = el.align === "L" ? "start" : el.align === "R" ? "end" : "middle";
      const x = el.align === "L" ? el.x : el.align === "R" ? el.x + el.width : el.x + el.width / 2;
      const fit = Math.min(el.width, estimateTextWidth(shown, el.fontHeight));
      parts.push(
        `<text x="${x}" y="${Math.round(el.y + el.fontHeight * 0.86)}" data-role="${el.role}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${el.fontHeight}" text-anchor="${anchor}" textLength="${fit}" lengthAdjust="spacingAndGlyphs" text-rendering="geometricPrecision" fill="${el.reverse ? "#fff" : "#000"}">${xmlEscape(shown)}</text>`,
      );
    } else {
      const matrix = options.qrMatrix?.(el.data);
      if (matrix) {
        if (matrix.length > el.modules) throw new Error("QR plus grand que la zone réservée.");
        const m = el.magnification;
        let d = "";
        matrix.forEach((row, r) =>
          row.forEach((dark, c) => {
            if (dark) d += `M${el.x + c * m} ${el.y + r * m}h${m}v${m}h-${m}z`;
          }),
        );
        parts.push(`<path data-role="${el.role}" d="${d}" fill="#000" shape-rendering="crispEdges"/>`);
      } else {
        const sizeDots = el.modules * el.magnification;
        parts.push(
          `<rect data-role="${el.role}" x="${el.x}" y="${el.y}" width="${sizeDots}" height="${sizeDots}" fill="#fff" stroke="#000" stroke-width="${el.magnification * 2}"/>`,
          `<text x="${el.x + sizeDots / 2}" y="${el.y + sizeDots / 2}" font-family="Arial, sans-serif" font-size="${sizeDots / 4}" text-anchor="middle" dominant-baseline="middle" fill="#000">QR</text>`,
        );
      }
    }
  }
  parts.push("</g></svg>");
  return parts.join("");
}

/** Build + validate the layout and render it. Throws LabelLayoutError. */
export function renderLabel(content: LabelContent, config: LabelConfig, options: SvgOptions = {}): { layout: LabelLayout; svg: string } {
  const layout = buildLayout(content, config);
  return { layout, svg: renderSvg(layout, options) };
}
