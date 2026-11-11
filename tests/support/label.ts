/** Read back what a label SVG shows (text fields, QR path) for assertions. */
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

export function svgTexts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]));
}

export function svgTextByRole(svg: string, role: string): string | null {
  const m = new RegExp(`<text\\b[^>]*data-role="${role}"[^>]*>(.*?)</text>`).exec(svg);
  return m ? m[1].replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]) : null;
}

export function svgQrPath(svg: string, role = "galia-qr"): string | null {
  const m = new RegExp(`<path data-role="${role}" d="([^"]*)"`).exec(svg);
  return m ? m[1] : null;
}

/** Path the renderer draws for a QR matrix at a given origin/magnification. */
export function expectedQrPath(matrix: boolean[][], x: number, y: number, m: number): string {
  let d = "";
  matrix.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${x + c * m} ${y + r * m}h${m}v${m}h-${m}z`;
    }),
  );
  return d;
}
