-- Printing through the browser print dialog (window.print + Windows ZD421 driver)
-- instead of Zebra Browser Print. Non-destructive: existing print jobs are kept
-- and tagged as legacy direct-printing jobs.

ALTER TYPE "PrintJobStatus" ADD VALUE IF NOT EXISTS 'DIALOG_REQUESTED';

ALTER TABLE "PrintJob" ADD COLUMN "method" VARCHAR(20) NOT NULL DEFAULT 'PRINT_DIALOG';
-- Existing rows were created for Zebra Browser Print (ZPL payload).
UPDATE "PrintJob" SET "method" = 'BROWSER_PRINT_ZPL';
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_method" CHECK ("method" IN ('PRINT_DIALOG', 'BROWSER_PRINT_ZPL'));

-- With the print dialog the printer is chosen by the operator in Windows: no device/DPI stored.
ALTER TABLE "PrintJob" ALTER COLUMN "printerName" DROP NOT NULL,
                       ALTER COLUMN "printerUid" DROP NOT NULL,
                       ALTER COLUMN "dpi" DROP NOT NULL;
ALTER TABLE "PrintJob" DROP CONSTRAINT "PrintJob_dpi";
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_dpi" CHECK ("dpi" IS NULL OR "dpi" IN (203, 300));

-- Payload and context stay immutable; DIALOG_REQUESTED is final (never upgraded to "printed").
CREATE OR REPLACE FUNCTION galia_print_job_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GALIA_GUARD: print jobs cannot be deleted';
  END IF;
  IF NEW."payload" <> OLD."payload" OR NEW."payloadSha256" <> OLD."payloadSha256"
     OR NEW."type" <> OLD."type" OR NEW."reportId" IS DISTINCT FROM OLD."reportId"
     OR NEW."requestedById" <> OLD."requestedById" OR NEW."sessionId" <> OLD."sessionId"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey" OR NEW."workstationId" <> OLD."workstationId"
     OR NEW."method" <> OLD."method" OR NEW."printerUid" IS DISTINCT FROM OLD."printerUid"
     OR NEW."dpi" IS DISTINCT FROM OLD."dpi" OR NEW."widthMm" <> OLD."widthMm" OR NEW."heightMm" <> OLD."heightMm" THEN
    RAISE EXCEPTION 'GALIA_GUARD: print job payload and context are immutable';
  END IF;
  IF OLD."status"::text IN ('SENT_TO_PRINTER', 'FAILED', 'DIALOG_REQUESTED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'GALIA_GUARD: print job % is already final (%)', OLD."id", OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
