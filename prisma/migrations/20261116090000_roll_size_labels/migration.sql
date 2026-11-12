-- Physical page = roll width × feed length. Rotate the reading content inside
-- the saved SVG, avoiding dependence on the browser/driver landscape mapping.
-- Only workstation settings change. Historical reports and print snapshots do not.
ALTER TABLE "PrinterProfile" DROP CONSTRAINT "PrinterProfile_size";
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_size"
  CHECK ("widthMm" BETWEEN 50 AND 112 AND "heightMm" BETWEEN 50 AND 991);
ALTER TABLE "PrinterProfile" ALTER COLUMN "orientation" SET DEFAULT 'ROTATE_90';

-- Keep explicit portrait and application-rotation choices. Migrate the previous
-- default landscape-page mode to the same reading direction on a roll-size page.
-- Larger type/margins require every workstation to measure a fresh TEST label.
UPDATE "PrinterProfile"
SET "orientation" = CASE WHEN "orientation" = 'LANDSCAPE' THEN 'ROTATE_90' ELSE "orientation" END,
    "confirmedAt" = NULL, "confirmedById" = NULL;
