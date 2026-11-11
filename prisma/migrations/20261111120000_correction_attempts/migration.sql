-- Correction of NOT OK boxes: control attempts (initial + corrections), several
-- immutable reports per box, items/scans linked to the attempt that produced them.
-- Non-destructive: only adds tables/columns/indexes, backfills existing data as
-- attempt #1, then replaces the guard functions. No row is deleted.

-- ------------------------------------------------------------------ types
CREATE TYPE "AttemptKind" AS ENUM ('INITIAL', 'CORRECTION');
CREATE TYPE "AttemptStatus" AS ENUM ('IN_PROGRESS', 'FINALIZED');

-- ------------------------------------------------------------ new table
CREATE TABLE "ControlAttempt" (
    "id" UUID NOT NULL,
    "boxId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "AttemptKind" NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "startedById" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMPTZ(3),
    "previousReportId" UUID,
    CONSTRAINT "ControlAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ControlAttempt_boxId_number_key" ON "ControlAttempt"("boxId", "number");
ALTER TABLE "ControlAttempt" ADD CONSTRAINT "ControlAttempt_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ControlAttempt" ADD CONSTRAINT "ControlAttempt_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ControlAttempt" ADD CONSTRAINT "ControlAttempt_previousReportId_fkey" FOREIGN KEY ("previousReportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ControlAttempt" ADD CONSTRAINT "ControlAttempt_number_positive" CHECK ("number" >= 1);
ALTER TABLE "ControlAttempt" ADD CONSTRAINT "ControlAttempt_kind_number" CHECK (("kind" = 'INITIAL') = ("number" = 1));
ALTER TABLE "ControlAttempt" ADD CONSTRAINT "ControlAttempt_finalized_at" CHECK (("status" = 'FINALIZED') = ("finalizedAt" IS NOT NULL));

-- --------------------------------------------- new columns (nullable first)
ALTER TABLE "Box" ADD COLUMN "activeAttemptId" UUID;
ALTER TABLE "AcceptedItem" ADD COLUMN "controlAttemptId" UUID;
ALTER TABLE "ScanAttempt" ADD COLUMN "controlAttemptId" UUID;
ALTER TABLE "Report" ADD COLUMN "attemptId" UUID,
                     ADD COLUMN "attemptNumber" INTEGER,
                     ADD COLUMN "kind" "AttemptKind";

-- ------------------------------------------------------------- backfill
-- Existing rows are history: guards are paused only for this backfill.
ALTER TABLE "Box" DISABLE TRIGGER "Box_guard";
ALTER TABLE "AcceptedItem" DISABLE TRIGGER "AcceptedItem_immutable";
ALTER TABLE "ScanAttempt" DISABLE TRIGGER "ScanAttempt_immutable";
ALTER TABLE "Report" DISABLE TRIGGER "Report_immutable";

-- Every existing box gets attempt #1 (INITIAL), finalized when the box is.
INSERT INTO "ControlAttempt" ("id", "boxId", "number", "kind", "status", "startedById", "startedAt", "finalizedAt")
SELECT gen_random_uuid(), b."id", 1, 'INITIAL',
       CASE WHEN b."status" = 'IN_PROGRESS' THEN 'IN_PROGRESS'::"AttemptStatus" ELSE 'FINALIZED'::"AttemptStatus" END,
       b."createdById", b."createdAt",
       CASE WHEN b."status" = 'IN_PROGRESS' THEN NULL ELSE COALESCE(b."finalizedAt", b."createdAt") END
FROM "Box" b;

UPDATE "Box" b SET "activeAttemptId" = a."id"
FROM "ControlAttempt" a WHERE a."boxId" = b."id" AND b."status" = 'IN_PROGRESS';

UPDATE "AcceptedItem" i SET "controlAttemptId" = a."id"
FROM "ControlAttempt" a WHERE a."boxId" = i."boxId" AND a."number" = 1;

UPDATE "ScanAttempt" s SET "controlAttemptId" = a."id"
FROM "ControlAttempt" a WHERE a."boxId" = s."boxId" AND a."number" = 1;

-- Existing reports keep their original counts; they become the report of attempt #1.
UPDATE "Report" r SET "attemptId" = a."id", "attemptNumber" = 1, "kind" = 'INITIAL'
FROM "ControlAttempt" a WHERE a."boxId" = r."boxId" AND a."number" = 1;

ALTER TABLE "Box" ENABLE TRIGGER "Box_guard";
ALTER TABLE "AcceptedItem" ENABLE TRIGGER "AcceptedItem_immutable";
ALTER TABLE "ScanAttempt" ENABLE TRIGGER "ScanAttempt_immutable";
ALTER TABLE "Report" ENABLE TRIGGER "Report_immutable";

-- ----------------------------------------------------- constraints/indexes
ALTER TABLE "AcceptedItem" ALTER COLUMN "controlAttemptId" SET NOT NULL;
ALTER TABLE "Report" ALTER COLUMN "attemptId" SET NOT NULL,
                     ALTER COLUMN "attemptNumber" SET NOT NULL,
                     ALTER COLUMN "kind" SET NOT NULL;

-- A box now has one report per finalized attempt (was: one report per box).
DROP INDEX "Report_boxId_key";
CREATE UNIQUE INDEX "Report_attemptId_key" ON "Report"("attemptId");
CREATE INDEX "Report_boxId_finalizedAt_idx" ON "Report"("boxId", "finalizedAt");
CREATE UNIQUE INDEX "Box_activeAttemptId_key" ON "Box"("activeAttemptId");

ALTER TABLE "Box" ADD CONSTRAINT "Box_activeAttemptId_fkey" FOREIGN KEY ("activeAttemptId") REFERENCES "ControlAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ScanAttempt" ADD CONSTRAINT "ScanAttempt_controlAttemptId_fkey" FOREIGN KEY ("controlAttemptId") REFERENCES "ControlAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AcceptedItem" ADD CONSTRAINT "AcceptedItem_controlAttemptId_fkey" FOREIGN KEY ("controlAttemptId") REFERENCES "ControlAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ControlAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_attemptNumber_positive" CHECK ("attemptNumber" >= 1);
CREATE INDEX "PrintJob_workstationId_createdAt_idx" ON "PrintJob"("workstationId", "createdAt");

-- ------------------------------------------------------ updated guards

-- Accepted items: only into the box's OPEN attempt, exact PN, cumulative quantity limit.
CREATE OR REPLACE FUNCTION galia_accepted_item_guard() RETURNS trigger AS $$
DECLARE
  b RECORD;
  n integer;
BEGIN
  SELECT "partNumber", "expectedQty", "activeAttemptId" INTO b FROM "Box" WHERE "id" = NEW."boxId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALIA_GUARD: box % not found', NEW."boxId";
  END IF;
  IF b."activeAttemptId" IS NULL THEN
    RAISE EXCEPTION 'GALIA_GUARD: box % is closed', NEW."boxId";
  END IF;
  IF NEW."controlAttemptId" IS DISTINCT FROM b."activeAttemptId" THEN
    RAISE EXCEPTION 'GALIA_GUARD: item must belong to the open attempt of box %', NEW."boxId";
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

-- Boxes: identity immutable; a closed OK box is final; a closed NOT OK box can only
-- be reopened through a new correction attempt; closing requires the attempt's report.
CREATE OR REPLACE FUNCTION galia_box_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GALIA_GUARD: boxes cannot be deleted';
  END IF;
  IF NEW."boxSerial" <> OLD."boxSerial" OR NEW."partNumber" <> OLD."partNumber"
     OR NEW."expectedQty" <> OLD."expectedQty" OR NEW."galiaPayload" <> OLD."galiaPayload"
     OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'GALIA_GUARD: box identity is immutable';
  END IF;
  IF OLD."activeAttemptId" IS NULL AND OLD."status" = 'OK' THEN
    RAISE EXCEPTION 'GALIA_GUARD: box % is OK and read-only', OLD."id";
  END IF;
  IF OLD."activeAttemptId" IS NULL AND OLD."status" = 'NOK'
     AND (NEW."activeAttemptId" IS NULL OR NEW."status" <> 'NOK') THEN
    RAISE EXCEPTION 'GALIA_GUARD: closed NOT OK box % can only be reopened for a correction', OLD."id";
  END IF;
  IF NEW."activeAttemptId" IS NOT NULL AND NEW."activeAttemptId" IS DISTINCT FROM OLD."activeAttemptId" THEN
    IF OLD."activeAttemptId" IS NOT NULL THEN
      RAISE EXCEPTION 'GALIA_GUARD: box % already has an open attempt', OLD."id";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "ControlAttempt" a WHERE a."id" = NEW."activeAttemptId" AND a."boxId" = NEW."id" AND a."status" = 'IN_PROGRESS') THEN
      RAISE EXCEPTION 'GALIA_GUARD: open attempt must be an in-progress attempt of box %', OLD."id";
    END IF;
  END IF;
  IF OLD."activeAttemptId" IS NOT NULL AND NEW."activeAttemptId" IS NULL THEN
    IF NEW."status" NOT IN ('OK', 'NOK')
       OR NOT EXISTS (SELECT 1 FROM "Report" r WHERE r."attemptId" = OLD."activeAttemptId" AND r."result" = NEW."status") THEN
      RAISE EXCEPTION 'GALIA_GUARD: an attempt can only be closed together with its report';
    END IF;
  ELSIF NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'GALIA_GUARD: box status changes only when an attempt is finalized';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attempts: never deleted; identity immutable; IN_PROGRESS -> FINALIZED once, with its report.
CREATE FUNCTION galia_attempt_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GALIA_GUARD: control attempts cannot be deleted';
  END IF;
  IF NEW."boxId" <> OLD."boxId" OR NEW."number" <> OLD."number" OR NEW."kind" <> OLD."kind"
     OR NEW."startedById" <> OLD."startedById" OR NEW."startedAt" <> OLD."startedAt"
     OR NEW."previousReportId" IS DISTINCT FROM OLD."previousReportId" THEN
    RAISE EXCEPTION 'GALIA_GUARD: control attempt identity is immutable';
  END IF;
  IF OLD."status" = 'FINALIZED' THEN
    RAISE EXCEPTION 'GALIA_GUARD: finalized attempt % is read-only', OLD."id";
  END IF;
  IF NEW."status" = 'FINALIZED' AND NOT EXISTS (SELECT 1 FROM "Report" r WHERE r."attemptId" = NEW."id") THEN
    RAISE EXCEPTION 'GALIA_GUARD: attempt % cannot be finalized without its report', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ControlAttempt_guard" BEFORE UPDATE OR DELETE ON "ControlAttempt"
  FOR EACH ROW EXECUTE FUNCTION galia_attempt_guard();
