import "server-only";
import QRCode from "qrcode";

/**
 * QR module matrix (error correction Q) for saved SVG labels and previews.
 * The browser prints this rendered symbol through the Windows driver.
 * The encoded text is exactly the given data.
 */
export function qrMatrix(data: string): boolean[][] {
  const qr = QRCode.create(data, { errorCorrectionLevel: "Q" });
  const size = qr.modules.size;
  const rows: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(qr.modules.get(r, c) === 1);
    rows.push(row);
  }
  return rows;
}
