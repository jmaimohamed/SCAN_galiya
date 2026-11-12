-- Strict start/end control with honest quantities (counting rules v2).
-- Non-destructive: adds columns/values, backfills legacy reports from their original
-- counts (counting version 1), replaces guard functions. No row is deleted.

-- A matching cover scanned beyond the GALIA quantity is an observation, never a reservation.
ALTER TYPE "ScanOutcome" ADD VALUE IF NOT EXISTS 'EXCESS';

-- ------------------------------------------------------------- report quantities
ALTER TABLE "Report"
  ADD COLUMN "countingVersion"    SMALLINT    NOT NULL DEFAULT 1,
  ADD COLUMN "distinctQty"        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "conformingQty"      INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "nonconformingQty"   INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "wrongPartNumberQty" INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "otherBoxQty"        INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "excessQty"          INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "extraQty"           INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "missingQty"         INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "duplicateAttempts"  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "invalidAttempts"    INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "endTrigger"         VARCHAR(16);

-- Legacy reports keep their original result and accepted count; the new columns are
-- derived from that count only (rules v1 did not record observations).
ALTER TABLE "Report" DISABLE TRIGGER "Report_immutable";
UPDATE "Report" SET
  "distinctQty" = "acceptedQty",
  "conformingQty" = "acceptedQty",
  "extraQty" = GREATEST(0, "acceptedQty" - "expectedQty"),
  "missingQty" = GREATEST(0, "expectedQty" - "acceptedQty");
ALTER TABLE "Report" ENABLE TRIGGER "Report_immutable";
ALTER TABLE "Report" ALTER COLUMN "countingVersion" SET DEFAULT 2;

ALTER TABLE "Report" ADD CONSTRAINT "Report_counting_version" CHECK ("countingVersion" IN (1, 2));
ALTER TABLE "Report" ADD CONSTRAINT "Report_counts_nonnegative" CHECK (
  "distinctQty" >= 0 AND "conformingQty" >= 0 AND "nonconformingQty" >= 0 AND "wrongPartNumberQty" >= 0 AND "otherBoxQty" >= 0
  AND "excessQty" >= 0 AND "extraQty" >= 0 AND "missingQty" >= 0 AND "duplicateAttempts" >= 0 AND "invalidAttempts" >= 0);
ALTER TABLE "Report" ADD CONSTRAINT "Report_v2_arithmetic" CHECK ("countingVersion" = 1 OR (
  "conformingQty" = "acceptedQty" + "excessQty"
  AND "nonconformingQty" = "wrongPartNumberQty" + "otherBoxQty"
  AND "distinctQty" = "conformingQty" + "nonconformingQty"
  AND "extraQty" = GREATEST(0, "distinctQty" - "expectedQty")
  AND "missingQty" = GREATEST(0, "expectedQty" - "conformingQty")));
ALTER TABLE "Report" ADD CONSTRAINT "Report_v2_strict_ok" CHECK ("countingVersion" = 1 OR "result" <> 'OK' OR (
  "distinctQty" = "expectedQty" AND "acceptedQty" = "expectedQty" AND "nonconformingQty" = 0 AND "excessQty" = 0 AND "extraQty" = 0
  AND "missingQty" = 0 AND "duplicateAttempts" = 0 AND "invalidAttempts" = 0 AND cardinality("issues") = 0));
ALTER TABLE "Report" ADD CONSTRAINT "Report_end_trigger" CHECK ("endTrigger" IS NULL OR "endTrigger" IN ('GALIA_RESCAN', 'MANUAL'));

-- Reports snapshot committed contents AND the attempt's recorded observations: the
-- counts are recomputed here, so no code path (even an administrator's) can turn a
-- control with a recorded mistake into OK.
CREATE OR REPLACE FUNCTION galia_report_insert_guard() RETURNS trigger AS $$
DECLARE b RECORD; n INTEGER; ex INTEGER; wp INTEGER; ob INTEGER; du INTEGER; inv INTEGER;
BEGIN
 SELECT * INTO b FROM "Box" WHERE "id" = NEW."boxId" FOR UPDATE;
 SELECT count(*) INTO n FROM "ActiveSerialReservation" WHERE "boxId" = b."id";
 -- Same rules as lib/counting.ts: observations are distinct cover serials per
 -- category (QUANTITY_REACHED = legacy name of an excess observation); duplicate
 -- and invalid scans are counted per attempt (each one is a recorded mistake).
 SELECT count(DISTINCT "serial") FILTER (WHERE "outcome"::text IN ('EXCESS', 'QUANTITY_REACHED')),
        count(DISTINCT "serial") FILTER (WHERE "outcome"::text = 'WRONG_PART_NUMBER'),
        count(DISTINCT "serial") FILTER (WHERE "outcome"::text = 'DUPLICATE_OTHER_BOX'),
        count(*) FILTER (WHERE "outcome"::text = 'DUPLICATE_SAME_BOX'),
        count(*) FILTER (WHERE "outcome"::text = 'INVALID_FORMAT')
   INTO ex, wp, ob, du, inv
   FROM "ScanAttempt" WHERE "controlAttemptId" = NEW."attemptId";
 IF NEW."attemptId" IS DISTINCT FROM b."activeAttemptId" OR NEW."partNumber" <> b."partNumber"
 OR NEW."boxSerial" <> b."boxSerial" OR NEW."galiaPayload" <> b."galiaPayload" OR NEW."expectedQty" <> b."expectedQty"
 OR NEW."acceptedQty" <> n OR NEW."difference" <> n - b."expectedQty"
 OR NEW."countingVersion" <> 2
 OR NEW."excessQty" <> ex OR NEW."wrongPartNumberQty" <> wp OR NEW."otherBoxQty" <> ob
 OR NEW."duplicateAttempts" <> du OR NEW."invalidAttempts" <> inv
 OR (NEW."result" = 'OK') IS DISTINCT FROM (n = b."expectedQty" AND ex + wp + ob + du + inv = 0 AND cardinality(NEW."issues") = 0)
 OR NOT EXISTS (SELECT 1 FROM "ControlAttempt" a WHERE a."id" = NEW."attemptId" AND a."generation" = b."generation" AND a."voidedAt" IS NULL AND a."status" = 'IN_PROGRESS' AND a."number" = NEW."attemptNumber" AND a."kind" = NEW."kind") THEN
  RAISE EXCEPTION 'GALIA_GUARD: report must match the current verified contents and recorded observations';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- ------------------------------------------------- label orientation per workstation
-- ROTATE_90: landscape content turned 90° on the page (text runs along the feed);
-- NONE: content laid out directly on the page. The new landscape layout must be
-- measured again with a TEST label, so existing confirmations are cleared.
ALTER TABLE "PrinterProfile" ADD COLUMN "orientation" VARCHAR(12) NOT NULL DEFAULT 'ROTATE_90';
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_orientation" CHECK ("orientation" IN ('ROTATE_90', 'NONE'));
UPDATE "PrinterProfile" SET "confirmedAt" = NULL, "confirmedById" = NULL;

ALTER TABLE "PrintJob" ADD COLUMN "orientation" VARCHAR(12);
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_orientation" CHECK ("orientation" IS NULL OR "orientation" IN ('ROTATE_90', 'NONE'));
