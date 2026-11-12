/**
 * CSS of the label print view (/etiquette/<job>). The printed page is exactly the
 * saved page: `@page` = widthMm × heightMm from the immutable print job,
 * no margin, and only the label sheet is visible. The saved SVG already contains
 * any required 90° rotation, so nothing is rotated here. New default jobs stay Portrait
 * (no CSS transform, no `size: landscape`). Every printed box is the exact page
 * size with overflow hidden, so rounding can never spill onto a second label.
 * Legacy LANDSCAPE jobs keep their original landscape page dimensions.
 */
export function labelPageCss(widthMm: number, heightMm: number): string {
  const w = `${widthMm}mm`;
  const h = `${heightMm}mm`;
  return `
@page { size: ${w} ${h}; margin: 0; }
.label-sheet { width: ${w}; height: ${h}; overflow: hidden; background: #fff; }
.label-sheet img { display: block; width: ${w}; height: ${h}; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; width: ${w} !important; height: ${h} !important; min-height: 0 !important; overflow: hidden !important; background: #fff !important; }
  .label-screen-only { display: none !important; }
  .label-sheet { margin: 0 !important; box-shadow: none !important; border: 0 !important; break-after: avoid; break-inside: avoid; page-break-after: avoid; }
}`;
}
