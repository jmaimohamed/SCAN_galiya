-- A legacy printer/DPI confirmation does not validate Windows-driver scaling.
-- Operators must measure a new TEST label after this upgrade. No history is removed.
UPDATE "PrinterProfile" SET "confirmedAt" = NULL, "confirmedById" = NULL;

-- Preserve every snapshot field, including operator, template, hash and reprint
-- context. Dialog requests have no later delivery status or mutable result.
CREATE OR REPLACE FUNCTION galia_print_job_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GALIA_GUARD: print jobs cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'claimedAt', 'claimedBySessionId', 'sentAt', 'finishedAt', 'errorMessage'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'claimedAt', 'claimedBySessionId', 'sentAt', 'finishedAt', 'errorMessage']) THEN
    RAISE EXCEPTION 'GALIA_GUARD: print job payload and context are immutable';
  END IF;
  IF OLD."method" = 'PRINT_DIALOG' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'GALIA_GUARD: dialog request is immutable and physical output is unconfirmed';
  END IF;
  IF OLD."status"::text IN ('SENT_TO_PRINTER', 'FAILED', 'DIALOG_REQUESTED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'GALIA_GUARD: print job % is already final (%)', OLD."id", OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
