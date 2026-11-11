import { toAsciiVocabulary } from "./encode";
import { buildLayout, estimateTextWidth, type LabelConfig, type LabelContent, type LabelLayout } from "./layout";

function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface SvgOptions {
  /** Real QR module matrix (server-side); without it a placeholder square is drawn. */
  qrMatrix?: (data: string) => boolean[][];
  /** Physical size (mm) for printing; omitted = scalable preview with an outline. */
  physical?: { widthMm: number; heightMm: number };
}

/**
 * SVG rendering of the label layout. With `physical`, the SVG is sized in
 * millimetres and is exactly what the browser prints (black on white). Text is
 * clamped with textLength to the width the layout validated, so browser fonts can
 * never overflow a field. QR codes are drawn module by module (crisp edges).
 */
export function renderSvg(layout: LabelLayout, options: SvgOptions = {}): string {
  const size = options.physical ? ` width="${options.physical.widthMm}mm" height="${options.physical.heightMm}mm"` : "";
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.widthDots} ${layout.heightDots}"${size} role="img" aria-label="Étiquette" data-template="${layout.template}">`,
    `<rect x="0" y="0" width="${layout.widthDots}" height="${layout.heightDots}" fill="#fff"${options.physical ? "" : ' stroke="#94a3b8" stroke-width="2"'}/>`,
  ];
  for (const el of layout.elements) {
    if (el.type === "rect") {
      if (el.filled) {
        parts.push(`<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="#000"/>`);
      } else {
        const t = el.thickness;
        parts.push(`<rect x="${el.x + t / 2}" y="${el.y + t / 2}" width="${el.width - t}" height="${el.height - t}" fill="none" stroke="#000" stroke-width="${t}"/>`);
      }
    } else if (el.type === "text") {
      const shown = layout.accentMode === "ASCII" ? toAsciiVocabulary(el.text) : el.text;
      const anchor = el.align === "L" ? "start" : el.align === "R" ? "end" : "middle";
      const x = el.align === "L" ? el.x : el.align === "R" ? el.x + el.width : el.x + el.width / 2;
      const fit = Math.min(el.width, estimateTextWidth(shown, el.fontHeight));
      parts.push(
        `<text x="${x}" y="${el.y + el.fontHeight * 0.82}" data-role="${el.role}" font-family="Arial Narrow, Arial, sans-serif" font-weight="700" font-size="${el.fontHeight}" text-anchor="${anchor}" textLength="${fit}" lengthAdjust="spacingAndGlyphs" fill="${el.reverse ? "#fff" : "#000"}">${xmlEscape(shown)}</text>`,
      );
    } else {
      const matrix = options.qrMatrix?.(el.data);
      if (matrix) {
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
  parts.push("</svg>");
  return parts.join("");
}

/** Build + validate the layout and render it. Throws LabelLayoutError. */
export function renderLabel(content: LabelContent, config: LabelConfig, options: SvgOptions = {}): { layout: LabelLayout; svg: string } {
  const layout = buildLayout(content, config);
  return { layout, svg: renderSvg(layout, options) };
}
