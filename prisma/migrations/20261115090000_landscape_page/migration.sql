-- Landscape page printed by the Windows driver (template galia-label-v4-full).
-- Non-destructive: widens the accepted stock sizes (roll up to 110 mm wide, the
-- ZD421 head prints 104 mm; labels up to 300 mm long), adds the LANDSCAPE
-- orientation and makes it the default. The label layout changed, so every
-- workstation measures a new TEST label: confirmations are cleared. Print jobs
-- and their saved label snapshots are not modified.

ALTER TABLE "PrinterProfile" DROP CONSTRAINT "PrinterProfile_size";
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_size" CHECK ("widthMm" BETWEEN 50 AND 110 AND "heightMm" BETWEEN 50 AND 300);

ALTER TABLE "PrinterProfile" DROP CONSTRAINT "PrinterProfile_orientation";
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_orientation" CHECK ("orientation" IN ('LANDSCAPE', 'ROTATE_90', 'NONE'));
ALTER TABLE "PrinterProfile" ALTER COLUMN "orientation" SET DEFAULT 'LANDSCAPE';
-- Plant decision: labels are read held horizontally (text along the label length).
UPDATE "PrinterProfile" SET "orientation" = 'LANDSCAPE', "confirmedAt" = NULL, "confirmedById" = NULL;

ALTER TABLE "PrintJob" DROP CONSTRAINT "PrintJob_orientation";
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_orientation" CHECK ("orientation" IS NULL OR "orientation" IN ('LANDSCAPE', 'ROTATE_90', 'NONE'));
