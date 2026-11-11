/**
 * Text helpers for labels. Labels are rendered as SVG/HTML and printed through
 * the browser print dialog (no printer command language is generated).
 */

export type AccentMode = "UTF8" | "ASCII";

/** Accent-free vocabulary (kept for completeness): "RÉIMPRESSION" -> "REIMPRESSION", "—" -> "-". */
export function toAsciiVocabulary(text: string): string {
  return text
    .replace(/[–—]/g, "-")
    .replace(/[‘’]/g, "'")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^ -~]/g, "?");
}

/** Make free display text (e.g. a workstation name) printable: no control characters. */
export function sanitizeDisplayText(text: string, max = 60): string {
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  // Display aid only (never a business identifier), so shortening is acceptable here.
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

/** The OK-label QR may only carry a validated GALIA payload ([A-Z0-9_]), byte for byte. */
export function isQrSafePayload(payload: string): boolean {
  return payload.length > 0 && payload.length <= 128 && /^[A-Z0-9_]+$/.test(payload);
}
