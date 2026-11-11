-- Non-destructive active assignments, archived control generations and tab presence.
ALTER TABLE "Box" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "generationStartedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "needsRecontrol" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "currentReportId" UUID, ADD COLUMN "notes" VARCHAR(500);
ALTER TABLE "ControlAttempt" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "administrativeRecontrol" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "voidedAt" TIMESTAMPTZ(3);
ALTER TABLE "ControlAttempt" DROP CONSTRAINT "ControlAttempt_kind_number";
ALTER TABLE "ScanAttempt" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AcceptedItem" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "voidedAt" TIMESTAMPTZ(3), ADD COLUMN "voidedById" UUID, ADD COLUMN "voidReason" VARCHAR(500);
ALTER TABLE "AcceptedItem" ADD CONSTRAINT "AcceptedItem_void_complete" CHECK
 (("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL) OR
  ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND length(trim("voidReason")) >= 3));
DROP INDEX "AcceptedItem_serial_key";
CREATE INDEX "AcceptedItem_serial_idx" ON "AcceptedItem"("serial");
CREATE INDEX "AcceptedItem_boxId_generation_voidedAt_idx" ON "AcceptedItem"("boxId", "generation", "voidedAt");
CREATE INDEX "ControlAttempt_boxId_generation_idx" ON "ControlAttempt"("boxId", "generation");
CREATE TABLE "ControlGeneration" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "boxId" UUID NOT NULL REFERENCES "Box"("id"),
 "number" INTEGER NOT NULL CHECK ("number" > 0), "partNumber" VARCHAR(40) NOT NULL,
 "boxSerial" VARCHAR(30) NOT NULL, "expectedQty" INTEGER NOT NULL CHECK ("expectedQty" BETWEEN 1 AND 999),
 "galiaPayload" VARCHAR(128) NOT NULL, "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "voidedAt" TIMESTAMPTZ(3), "voidedById" UUID REFERENCES "User"("id"), "voidReason" VARCHAR(500),
 CONSTRAINT "ControlGeneration_void_complete" CHECK
 (("voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL) OR
  ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND length(trim("voidReason")) >= 3))
);
CREATE UNIQUE INDEX "ControlGeneration_boxId_number_key" ON "ControlGeneration"("boxId", "number");
CREATE INDEX "ControlGeneration_voidedAt_idx" ON "ControlGeneration"("voidedAt");
INSERT INTO "ControlGeneration" ("boxId", "number", "partNumber", "boxSerial", "expectedQty", "galiaPayload", "startedAt")
 SELECT "id", 1, "partNumber", "boxSerial", "expectedQty", "galiaPayload", "createdAt" FROM "Box";
ALTER TABLE "Box" DISABLE TRIGGER "Box_guard";
UPDATE "Box" b SET "generationStartedAt" = b."createdAt", "currentReportId" =
 (SELECT r."id" FROM "Report" r WHERE r."boxId" = b."id" ORDER BY r."finalizedAt" DESC, r."number" DESC LIMIT 1);
ALTER TABLE "Box" ENABLE TRIGGER "Box_guard";
ALTER TABLE "Box" ADD CONSTRAINT "Box_currentReportId_fkey" FOREIGN KEY ("currentReportId") REFERENCES "Report"("id");
ALTER TABLE "Box" ADD CONSTRAINT "Box_generation_positive" CHECK ("generation" > 0);
CREATE INDEX "Box_needsRecontrol_finalizedAt_idx" ON "Box"("needsRecontrol", "finalizedAt");
CREATE INDEX "Box_generationStartedAt_idx" ON "Box"("generationStartedAt");
CREATE INDEX "Box_finalizedAt_idx" ON "Box"("finalizedAt");
CREATE TABLE "ActiveSerialReservation" (
 "serial" VARCHAR(30) PRIMARY KEY, "itemId" UUID NOT NULL REFERENCES "AcceptedItem"("id"),
 "boxId" UUID NOT NULL REFERENCES "Box"("id"), "generation" INTEGER NOT NULL
);
CREATE UNIQUE INDEX "ActiveSerialReservation_itemId_key" ON "ActiveSerialReservation"("itemId");
CREATE INDEX "ActiveSerialReservation_boxId_generation_idx" ON "ActiveSerialReservation"("boxId", "generation");
INSERT INTO "ActiveSerialReservation" SELECT "serial", "id", "boxId", "generation" FROM "AcceptedItem";
CREATE TABLE "BrowserPresence" (
 "tabId" UUID PRIMARY KEY, "sessionId" CHAR(64) NOT NULL REFERENCES "Session"("id"),
 "workstationId" UUID, "boxId" UUID REFERENCES "Box"("id"),
 "heartbeatAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "activityAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BrowserPresence_sessionId_heartbeatAt_idx" ON "BrowserPresence"("sessionId", "heartbeatAt");
CREATE INDEX "BrowserPresence_heartbeatAt_idx" ON "BrowserPresence"("heartbeatAt");

-- Administrative context is server-set, transaction-local, and verified against
-- a live authenticated ADMIN session. Historical records still cannot be erased.
CREATE FUNCTION galia_admin_id() RETURNS UUID AS $$
 SELECT u."id" FROM "Session" s JOIN "User" u ON u."id" = s."userId"
 WHERE s."id" = current_setting('galia.admin_session', true) AND u."role" = 'ADMIN'
 AND u."active" AND s."revokedAt" IS NULL AND s."expiresAt" > CURRENT_TIMESTAMP
 AND length(trim(current_setting('galia.admin_reason', true))) BETWEEN 3 AND 500;
$$ LANGUAGE SQL STABLE;

CREATE FUNCTION galia_generation_insert() RETURNS trigger AS $$
BEGIN
 INSERT INTO "ControlGeneration" ("boxId", "number", "partNumber", "boxSerial", "expectedQty", "galiaPayload", "startedAt")
 VALUES (NEW."id", NEW."generation", NEW."partNumber", NEW."boxSerial", NEW."expectedQty", NEW."galiaPayload", NEW."generationStartedAt");
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "Box_generation" AFTER INSERT ON "Box" FOR EACH ROW EXECUTE FUNCTION galia_generation_insert();

CREATE FUNCTION galia_generation_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: generations cannot be deleted'; END IF;
 IF galia_admin_id() IS NULL OR OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
 OR NEW."voidedById" IS DISTINCT FROM galia_admin_id()
 OR NEW."voidReason" IS DISTINCT FROM current_setting('galia.admin_reason', true)
 OR (to_jsonb(NEW) - ARRAY['voidedAt','voidedById','voidReason']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['voidedAt','voidedById','voidReason']) THEN
  RAISE EXCEPTION 'GALIA_GUARD: generation can only be archived by an administrator';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "ControlGeneration_guard" BEFORE UPDATE OR DELETE ON "ControlGeneration" FOR EACH ROW EXECUTE FUNCTION galia_generation_guard();

-- Every insert reserves its serial in the same transaction, under the box lock.
CREATE OR REPLACE FUNCTION galia_accepted_item_guard() RETURNS trigger AS $$
DECLARE b RECORD; n INTEGER;
BEGIN
 SELECT * INTO b FROM "Box" WHERE "id" = NEW."boxId" FOR UPDATE;
 IF b."activeAttemptId" IS NULL OR NEW."controlAttemptId" IS DISTINCT FROM b."activeAttemptId"
 OR NEW."generation" <> b."generation" OR NEW."partNumber" <> b."partNumber" OR NEW."voidedAt" IS NOT NULL
 OR NOT EXISTS (SELECT 1 FROM "ControlAttempt" a WHERE a."id" = NEW."controlAttemptId" AND a."voidedAt" IS NULL AND a."status" = 'IN_PROGRESS' AND a."generation" = b."generation") THEN
  RAISE EXCEPTION 'GALIA_GUARD: accepted item requires the current open control and exact PN';
 END IF;
 SELECT count(*) INTO n FROM "ActiveSerialReservation" WHERE "boxId" = b."id";
 IF n >= b."expectedQty" THEN RAISE EXCEPTION 'GALIA_GUARD: expected quantity already reached'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE FUNCTION galia_reserve_serial() RETURNS trigger AS $$
BEGIN
 INSERT INTO "ActiveSerialReservation" VALUES (NEW."serial", NEW."id", NEW."boxId", NEW."generation");
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "AcceptedItem_reserve" AFTER INSERT ON "AcceptedItem" FOR EACH ROW EXECUTE FUNCTION galia_reserve_serial();
DROP TRIGGER "AcceptedItem_immutable" ON "AcceptedItem";
CREATE FUNCTION galia_void_item() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: accepted history cannot be deleted'; END IF;
 PERFORM 1 FROM "Box" WHERE "id" = OLD."boxId" FOR UPDATE;
 IF galia_admin_id() IS NULL OR OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
 OR NEW."voidedById" IS DISTINCT FROM galia_admin_id()
 OR NEW."voidReason" IS DISTINCT FROM current_setting('galia.admin_reason', true)
 OR (to_jsonb(NEW) - ARRAY['voidedAt','voidedById','voidReason']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['voidedAt','voidedById','voidReason']) THEN
  RAISE EXCEPTION 'GALIA_GUARD: only an administrator can void an active accepted item';
 END IF;
 DELETE FROM "ActiveSerialReservation" WHERE "itemId" = OLD."id";
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "AcceptedItem_immutable" BEFORE UPDATE OR DELETE ON "AcceptedItem" FOR EACH ROW EXECUTE FUNCTION galia_void_item();
CREATE FUNCTION galia_reservation_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'UPDATE' OR (TG_OP = 'DELETE' AND (pg_trigger_depth() < 2 OR galia_admin_id() IS NULL))
 OR (TG_OP = 'INSERT' AND pg_trigger_depth() < 2) THEN
  RAISE EXCEPTION 'GALIA_GUARD: reservations change only with accepted-item insert/void';
 END IF;
 RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "ActiveSerialReservation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "ActiveSerialReservation" FOR EACH ROW EXECUTE FUNCTION galia_reservation_guard();

CREATE OR REPLACE FUNCTION galia_attempt_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: attempts cannot be deleted'; END IF;
 IF (to_jsonb(NEW) - ARRAY['status','finalizedAt','voidedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','finalizedAt','voidedAt'])
 OR OLD."voidedAt" IS NOT NULL THEN RAISE EXCEPTION 'GALIA_GUARD: attempt identity is immutable'; END IF;
 IF NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt" THEN
  IF galia_admin_id() IS NULL OR NEW."status" <> OLD."status" OR NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt" THEN
   RAISE EXCEPTION 'GALIA_GUARD: only an administrator may void an attempt'; END IF;
 ELSIF OLD."status" = 'FINALIZED' OR NOT EXISTS (SELECT 1 FROM "Report" WHERE "attemptId" = NEW."id") THEN
  RAISE EXCEPTION 'GALIA_GUARD: attempt finalization requires its immutable report';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Reports can only snapshot committed active contents; even an admin cannot fabricate OK.
CREATE FUNCTION galia_report_insert_guard() RETURNS trigger AS $$
DECLARE b RECORD; n INTEGER;
BEGIN
 SELECT * INTO b FROM "Box" WHERE "id" = NEW."boxId" FOR UPDATE;
 SELECT count(*) INTO n FROM "ActiveSerialReservation" WHERE "boxId" = b."id";
 IF NEW."attemptId" IS DISTINCT FROM b."activeAttemptId" OR NEW."partNumber" <> b."partNumber"
 OR NEW."boxSerial" <> b."boxSerial" OR NEW."galiaPayload" <> b."galiaPayload" OR NEW."expectedQty" <> b."expectedQty"
 OR NEW."acceptedQty" <> n OR NEW."difference" <> n - b."expectedQty"
 OR (NEW."result" = 'OK') IS DISTINCT FROM (n = b."expectedQty" AND cardinality(NEW."issues") = 0)
 OR NOT EXISTS (SELECT 1 FROM "ControlAttempt" a WHERE a."id" = NEW."attemptId" AND a."generation" = b."generation" AND a."voidedAt" IS NULL AND a."status" = 'IN_PROGRESS' AND a."number" = NEW."attemptNumber" AND a."kind" = NEW."kind") THEN
  RAISE EXCEPTION 'GALIA_GUARD: report must match the current verified contents';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "Report_validate" BEFORE INSERT ON "Report" FOR EACH ROW EXECUTE FUNCTION galia_report_insert_guard();

CREATE OR REPLACE FUNCTION galia_box_guard() RETURNS trigger AS $$
DECLARE admin UUID := galia_admin_id();
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: boxes cannot be deleted'; END IF;
 IF NEW."id" <> OLD."id" OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
  RAISE EXCEPTION 'GALIA_GUARD: stable box identity is immutable'; END IF;
 IF admin IS NOT NULL THEN
  IF (to_jsonb(NEW) - 'notes') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'notes') THEN RETURN NEW; END IF;
  IF NEW."status" <> 'IN_PROGRESS' OR NEW."currentReportId" IS NOT NULL OR NOT NEW."needsRecontrol"
   OR NEW."finalizedAt" IS NOT NULL OR NEW."finalizedById" IS NOT NULL THEN
   RAISE EXCEPTION 'GALIA_GUARD: administrative integrity changes require invalidation'; END IF;
  IF NEW."generation" <> OLD."generation" THEN
   IF NEW."generation" <> OLD."generation" + 1 OR NEW."activeAttemptId" IS NOT NULL OR NEW."ownerSessionId" IS NOT NULL
    OR EXISTS (SELECT 1 FROM "ActiveSerialReservation" WHERE "boxId" = OLD."id")
    OR NOT EXISTS (SELECT 1 FROM "ControlGeneration" WHERE "boxId" = OLD."id" AND "number" = OLD."generation" AND "voidedAt" IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM "ControlGeneration" WHERE "boxId" = NEW."id" AND "number" = NEW."generation" AND "voidedAt" IS NULL) THEN
    RAISE EXCEPTION 'GALIA_GUARD: reset requires a new generation and release of only the old assignments'; END IF;
  ELSIF NEW."boxSerial" <> OLD."boxSerial" OR NEW."partNumber" <> OLD."partNumber" OR NEW."expectedQty" <> OLD."expectedQty" OR NEW."galiaPayload" <> OLD."galiaPayload" THEN
   RAISE EXCEPTION 'GALIA_GUARD: identity editing requires a reset generation';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW."generation" <> OLD."generation" OR NEW."generationStartedAt" <> OLD."generationStartedAt" OR NEW."notes" IS DISTINCT FROM OLD."notes"
 OR NEW."boxSerial" <> OLD."boxSerial" OR NEW."partNumber" <> OLD."partNumber" OR NEW."expectedQty" <> OLD."expectedQty" OR NEW."galiaPayload" <> OLD."galiaPayload" THEN
  RAISE EXCEPTION 'GALIA_GUARD: box identity is immutable'; END IF;
 IF OLD."activeAttemptId" IS NULL AND OLD."status" = 'OK' THEN RAISE EXCEPTION 'GALIA_GUARD: OK box is read-only'; END IF;
 IF NEW."activeAttemptId" IS NOT NULL THEN
  IF NOT EXISTS (SELECT 1 FROM "ControlAttempt" a WHERE a."id" = NEW."activeAttemptId" AND a."boxId" = NEW."id" AND a."generation" = NEW."generation" AND a."status" = 'IN_PROGRESS' AND a."voidedAt" IS NULL)
   OR (OLD."activeAttemptId" IS NOT NULL AND OLD."activeAttemptId" <> NEW."activeAttemptId") THEN
   RAISE EXCEPTION 'GALIA_GUARD: invalid active attempt'; END IF;
 END IF;
 IF OLD."activeAttemptId" IS NOT NULL AND NEW."activeAttemptId" IS NULL THEN
  IF NOT EXISTS (SELECT 1 FROM "Report" r WHERE r."id" = NEW."currentReportId" AND r."attemptId" = OLD."activeAttemptId" AND r."result" = NEW."status")
   OR NEW."status" NOT IN ('OK','NOK') OR NEW."needsRecontrol" THEN
   RAISE EXCEPTION 'GALIA_GUARD: closing requires a current valid report'; END IF;
 ELSE
  IF NEW."status" <> OLD."status" OR NEW."currentReportId" IS DISTINCT FROM OLD."currentReportId" OR NEW."needsRecontrol" <> OLD."needsRecontrol"
   OR NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt" OR NEW."finalizedById" IS DISTINCT FROM OLD."finalizedById" THEN
   RAISE EXCEPTION 'GALIA_GUARD: final result changes only on finalization'; END IF;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- A void cannot commit while leaving an old finalized result active.
CREATE FUNCTION galia_void_consistency() RETURNS trigger AS $$
BEGIN
 IF NEW."voidedAt" IS NOT NULL AND EXISTS (SELECT 1 FROM "Box" WHERE "id" = NEW."boxId" AND "currentReportId" IS NOT NULL) THEN
  RAISE EXCEPTION 'GALIA_GUARD: voiding contents must invalidate the current result'; END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "AcceptedItem_void_consistency" AFTER UPDATE ON "AcceptedItem"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION galia_void_consistency();

-- Serialize administrator role changes, also for mutations outside the UI.
CREATE FUNCTION galia_last_admin_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: users must be deactivated, never deleted'; END IF;
 IF OLD."role" = 'ADMIN' AND OLD."active" AND (NEW."role" <> 'ADMIN' OR NOT NEW."active") THEN
  PERFORM pg_advisory_xact_lock(71920341);
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" <> OLD."id" AND "role" = 'ADMIN' AND "active") THEN
   RAISE EXCEPTION 'GALIA_GUARD: last active administrator cannot be removed'; END IF;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "User_last_admin" BEFORE UPDATE OR DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION galia_last_admin_guard();
