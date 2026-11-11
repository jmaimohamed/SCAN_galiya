-- Integrity guards that Prisma's schema language cannot express.
-- Defense in depth: the application already enforces these rules inside
-- transactions holding the box row lock; the database refuses violations even
-- if application code were wrong.

-- ---------------------------------------------------------------- CHECKs
ALTER TABLE "Box" ADD CONSTRAINT "Box_expectedQty_range" CHECK ("expectedQty" BETWEEN 1 AND 999);
ALTER TABLE "Box" ADD CONSTRAINT "Box_boxSerial_digits" CHECK ("boxSerial" ~ '^[0-9]+$');
ALTER TABLE "Box" ADD CONSTRAINT "Box_partNumber_chars" CHECK ("partNumber" ~ '^[A-Z0-9]+$');
ALTER TABLE "Box" ADD CONSTRAINT "Box_galiaPayload_chars" CHECK ("galiaPayload" ~ '^[A-Z0-9_]+$');
ALTER TABLE "AcceptedItem" ADD CONSTRAINT "AcceptedItem_serial_digits" CHECK ("serial" ~ '^[0-9]+$');
ALTER TABLE "Report" ADD CONSTRAINT "Report_result_final" CHECK ("result" IN ('OK', 'NOK'));
ALTER TABLE "Report" ADD CONSTRAINT "Report_counts" CHECK ("acceptedQty" >= 0 AND "expectedQty" >= 1 AND "difference" = "acceptedQty" - "expectedQty");
ALTER TABLE "Report" ADD CONSTRAINT "Report_ok_is_complete" CHECK ("result" <> 'OK' OR ("acceptedQty" = "expectedQty" AND cardinality("issues") = 0));
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_dpi" CHECK ("dpi" IS NULL OR "dpi" IN (203, 300));
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_size" CHECK ("widthMm" BETWEEN 50 AND 104 AND "heightMm" BETWEEN 50 AND 200);
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_accent" CHECK ("accentMode" IN ('UTF8', 'ASCII'));
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_dpi" CHECK ("dpi" IN (203, 300));
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_report_unless_test" CHECK (("type" = 'TEST') = ("reportId" IS NULL));

-- ------------------------------------------------- accepted-item guard
-- Locks the parent box row and re-checks status, PN equality and quantity.
CREATE FUNCTION galia_accepted_item_guard() RETURNS trigger AS $$
DECLARE
  b RECORD;
  n integer;
BEGIN
  SELECT "status", "partNumber", "expectedQty" INTO b FROM "Box" WHERE "id" = NEW."boxId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALIA_GUARD: box % not found', NEW."boxId";
  END IF;
  IF b."status" <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'GALIA_GUARD: box % is finalized', NEW."boxId";
  END IF;
  IF NEW."partNumber" <> b."partNumber" THEN
    RAISE EXCEPTION 'GALIA_GUARD: part number mismatch';
  END IF;
  SELECT count(*) INTO n FROM "AcceptedItem" WHERE "boxId" = NEW."boxId";
  IF n >= b."expectedQty" THEN
    RAISE EXCEPTION 'GALIA_GUARD: expected quantity already reached';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AcceptedItem_guard" BEFORE INSERT ON "AcceptedItem"
  FOR EACH ROW EXECUTE FUNCTION galia_accepted_item_guard();

-- ------------------------------------------------- append-only tables
CREATE FUNCTION galia_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'GALIA_GUARD: % rows are immutable (% refused)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AcceptedItem_immutable" BEFORE UPDATE OR DELETE ON "AcceptedItem"
  FOR EACH ROW EXECUTE FUNCTION galia_append_only();
CREATE TRIGGER "ScanAttempt_immutable" BEFORE UPDATE OR DELETE ON "ScanAttempt"
  FOR EACH ROW EXECUTE FUNCTION galia_append_only();
CREATE TRIGGER "Report_immutable" BEFORE UPDATE OR DELETE ON "Report"
  FOR EACH ROW EXECUTE FUNCTION galia_append_only();
CREATE TRIGGER "AuditEvent_immutable" BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION galia_append_only();

-- ------------------------------------------------------------ boxes
-- Identity columns never change; a finalized box is read-only; boxes are never deleted.
CREATE FUNCTION galia_box_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GALIA_GUARD: boxes cannot be deleted';
  END IF;
  IF OLD."status" <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'GALIA_GUARD: finalized box % is read-only', OLD."id";
  END IF;
  IF NEW."boxSerial" <> OLD."boxSerial" OR NEW."partNumber" <> OLD."partNumber"
     OR NEW."expectedQty" <> OLD."expectedQty" OR NEW."galiaPayload" <> OLD."galiaPayload"
     OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'GALIA_GUARD: box identity is immutable';
  END IF;
  IF NEW."status" <> 'IN_PROGRESS' AND NOT EXISTS (SELECT 1 FROM "Report" WHERE "boxId" = NEW."id") THEN
    RAISE EXCEPTION 'GALIA_GUARD: a box can only be finalized together with its report';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Box_guard" BEFORE UPDATE OR DELETE ON "Box"
  FOR EACH ROW EXECUTE FUNCTION galia_box_guard();

-- ------------------------------------------------------- print jobs
-- Status fields move forward; the printed payload and its context never change.
CREATE FUNCTION galia_print_job_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GALIA_GUARD: print jobs cannot be deleted';
  END IF;
  IF NEW."payload" <> OLD."payload" OR NEW."payloadSha256" <> OLD."payloadSha256"
     OR NEW."type" <> OLD."type" OR NEW."reportId" IS DISTINCT FROM OLD."reportId"
     OR NEW."requestedById" <> OLD."requestedById" OR NEW."sessionId" <> OLD."sessionId"
     OR NEW."idempotencyKey" <> OLD."idempotencyKey" OR NEW."printerUid" <> OLD."printerUid"
     OR NEW."dpi" <> OLD."dpi" OR NEW."widthMm" <> OLD."widthMm" OR NEW."heightMm" <> OLD."heightMm" THEN
    RAISE EXCEPTION 'GALIA_GUARD: print job payload and context are immutable';
  END IF;
  IF OLD."status" IN ('SENT_TO_PRINTER', 'FAILED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'GALIA_GUARD: print job % is already final (%)', OLD."id", OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PrintJob_guard" BEFORE UPDATE OR DELETE ON "PrintJob"
  FOR EACH ROW EXECUTE FUNCTION galia_print_job_guard();

-- Users are deactivated, never deleted (traceability).
CREATE FUNCTION galia_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'GALIA_GUARD: % rows cannot be deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_no_delete" BEFORE DELETE ON "User"
  FOR EACH ROW EXECUTE FUNCTION galia_no_delete();
