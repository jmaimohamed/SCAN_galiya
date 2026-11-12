-- Custom browser-page widths and an explicit printable band per workstation.
-- Existing geometry and confirmations remain valid (the default band is 104 mm).
-- Reports and immutable print snapshots are unchanged.
ALTER TABLE "PrinterProfile" ADD COLUMN "printableWidthMm" INTEGER DEFAULT 104;
ALTER TABLE "PrinterProfile" DROP CONSTRAINT "PrinterProfile_size";
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_size"
  CHECK ("widthMm" BETWEEN 50 AND 991 AND "heightMm" BETWEEN 50 AND 991);
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_printable_width"
  CHECK ("printableWidthMm" IS NULL OR "printableWidthMm" BETWEEN 50 AND 991);
