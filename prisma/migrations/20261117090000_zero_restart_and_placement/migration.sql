-- Non-destructive: a confirmed NOT OK recontrol starts a new generation at zero.
-- This capability is distinct from administration and can never reset OK/open boxes.
CREATE FUNCTION galia_nok_restart_id(target UUID) RETURNS UUID AS $$
 SELECT u."id" FROM "Session" s JOIN "User" u ON u."id" = s."userId"
 JOIN "Box" b ON b."id" = target
 JOIN "Report" r ON r."id" = b."currentReportId" AND r."boxId" = b."id"
 JOIN "ControlAttempt" a ON a."id" = r."attemptId" AND a."generation" = b."generation"
 WHERE s."id" = current_setting('galia.nok_restart_session', true)
 AND u."active" AND u."role" IN ('OPERATOR','ADMIN')
 AND s."revokedAt" IS NULL AND s."expiresAt" > CURRENT_TIMESTAMP
 AND b."id"::text = current_setting('galia.nok_restart_box', true)
 AND r."id"::text = current_setting('galia.nok_restart_report', true)
 AND b."status" = 'NOK' AND r."result" = 'NOK' AND a."status" = 'FINALIZED'
 AND b."activeAttemptId" IS NULL AND NOT b."needsRecontrol"
 AND length(trim(current_setting('galia.nok_restart_reason', true))) BETWEEN 3 AND 500;
$$ LANGUAGE SQL STABLE;


CREATE OR REPLACE FUNCTION galia_generation_guard() RETURNS trigger AS $$
DECLARE actor UUID; reason TEXT;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: generations cannot be deleted'; END IF;
 actor := galia_admin_id();
 reason := current_setting('galia.admin_reason', true);
 IF actor IS NULL AND OLD."number" = (SELECT "generation" FROM "Box" WHERE "id" = OLD."boxId") THEN
  actor := galia_nok_restart_id(OLD."boxId"); reason := current_setting('galia.nok_restart_reason', true);
 END IF;
 IF actor IS NULL OR OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
 OR NEW."voidedById" IS DISTINCT FROM actor
 OR NEW."voidReason" IS DISTINCT FROM reason
 OR (to_jsonb(NEW) - ARRAY['voidedAt','voidedById','voidReason']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['voidedAt','voidedById','voidReason']) THEN
  RAISE EXCEPTION 'GALIA_GUARD: generation can only be archived by an administrator';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION galia_void_item() RETURNS trigger AS $$
DECLARE actor UUID; reason TEXT;
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: accepted history cannot be deleted'; END IF;
 PERFORM 1 FROM "Box" WHERE "id" = OLD."boxId" FOR UPDATE;
 actor := galia_admin_id();
 reason := current_setting('galia.admin_reason', true);
 IF actor IS NULL AND OLD."generation" = (SELECT "generation" FROM "Box" WHERE "id" = OLD."boxId") THEN
  actor := galia_nok_restart_id(OLD."boxId"); reason := current_setting('galia.nok_restart_reason', true);
 END IF;
 IF actor IS NULL OR OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
 OR NEW."voidedById" IS DISTINCT FROM actor
 OR NEW."voidReason" IS DISTINCT FROM reason
 OR (to_jsonb(NEW) - ARRAY['voidedAt','voidedById','voidReason']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['voidedAt','voidedById','voidReason']) THEN
  RAISE EXCEPTION 'GALIA_GUARD: only an administrator can void an active accepted item';
 END IF;
 DELETE FROM "ActiveSerialReservation" WHERE "itemId" = OLD."id";
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION galia_reservation_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'UPDATE' OR (TG_OP = 'DELETE' AND (pg_trigger_depth() < 2 OR (galia_admin_id() IS NULL AND galia_nok_restart_id(OLD."boxId") IS NULL)))
 OR (TG_OP = 'INSERT' AND pg_trigger_depth() < 2) THEN
  RAISE EXCEPTION 'GALIA_GUARD: reservations change only with accepted-item insert/void';
 END IF;
 RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION galia_attempt_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: attempts cannot be deleted'; END IF;
 IF (to_jsonb(NEW) - ARRAY['status','finalizedAt','voidedAt']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','finalizedAt','voidedAt'])
 OR OLD."voidedAt" IS NOT NULL THEN RAISE EXCEPTION 'GALIA_GUARD: attempt identity is immutable'; END IF;
 IF NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt" THEN
  IF (galia_admin_id() IS NULL AND (galia_nok_restart_id(OLD."boxId") IS NULL
    OR OLD."generation" <> (SELECT "generation" FROM "Box" WHERE "id" = OLD."boxId") OR OLD."status" <> 'FINALIZED')) OR NEW."status" <> OLD."status" OR NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt" THEN
   RAISE EXCEPTION 'GALIA_GUARD: only an administrator may void an attempt'; END IF;
 ELSIF OLD."status" = 'FINALIZED' OR NOT EXISTS (SELECT 1 FROM "Report" WHERE "attemptId" = NEW."id") THEN
  RAISE EXCEPTION 'GALIA_GUARD: attempt finalization requires its immutable report';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION galia_box_guard() RETURNS trigger AS $$
DECLARE admin UUID := galia_admin_id();
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GALIA_GUARD: boxes cannot be deleted'; END IF;
 IF NEW."id" <> OLD."id" OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
  RAISE EXCEPTION 'GALIA_GUARD: stable box identity is immutable'; END IF;
 -- Narrow operator capability: only release the current closed NOT OK generation,
 -- preserve all box identity, archive it, clear production state and revoke leases.
 IF NEW."generation" <> OLD."generation" AND galia_nok_restart_id(OLD."id") IS NOT NULL THEN
  IF NEW."generation" <> OLD."generation" + 1 OR NEW."status" <> 'IN_PROGRESS'
   OR NEW."currentReportId" IS NOT NULL OR NOT NEW."needsRecontrol"
   OR NEW."activeAttemptId" IS NOT NULL OR NEW."ownerUserId" IS NOT NULL OR NEW."ownerSessionId" IS NOT NULL
   OR NEW."leaseTokenHash" IS NOT NULL OR NEW."ownerSince" IS NOT NULL
   OR NEW."finalizedAt" IS NOT NULL OR NEW."finalizedById" IS NOT NULL
   OR (to_jsonb(NEW) - ARRAY['generation','generationStartedAt','status','currentReportId','needsRecontrol','activeAttemptId','ownerUserId','ownerSessionId','leaseTokenHash','ownerSince','finalizedAt','finalizedById']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['generation','generationStartedAt','status','currentReportId','needsRecontrol','activeAttemptId','ownerUserId','ownerSessionId','leaseTokenHash','ownerSince','finalizedAt','finalizedById'])
   OR EXISTS (SELECT 1 FROM "ActiveSerialReservation" WHERE "boxId" = OLD."id")
   OR EXISTS (SELECT 1 FROM "AcceptedItem" WHERE "boxId" = OLD."id" AND "generation" = OLD."generation" AND "voidedAt" IS NULL)
   OR EXISTS (SELECT 1 FROM "ControlAttempt" WHERE "boxId" = OLD."id" AND "generation" = OLD."generation" AND "voidedAt" IS NULL)
   OR NOT EXISTS (SELECT 1 FROM "ControlGeneration" WHERE "boxId" = OLD."id" AND "number" = OLD."generation" AND "voidedAt" IS NOT NULL)
   OR NOT EXISTS (SELECT 1 FROM "ControlGeneration" WHERE "boxId" = NEW."id" AND "number" = NEW."generation" AND "voidedAt" IS NULL
     AND "partNumber" = NEW."partNumber" AND "boxSerial" = NEW."boxSerial" AND "expectedQty" = NEW."expectedQty" AND "galiaPayload" = NEW."galiaPayload") THEN
   RAISE EXCEPTION 'GALIA_GUARD: NOT OK restart requires an archived generation, zero contents and unchanged box identity';
  END IF;
  RETURN NEW;
 END IF;
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

-- Per-browser physical placement. NULL length uses the complete measured stock.
ALTER TABLE "PrinterProfile" ADD COLUMN "contentPosition" VARCHAR(6) NOT NULL DEFAULT 'CENTER',
 ADD COLUMN "contentLengthMm" INTEGER;
ALTER TABLE "PrinterProfile" ADD CONSTRAINT "PrinterProfile_placement" CHECK (
 "contentPosition" IN ('TOP','CENTER','BOTTOM') AND
 ("contentLengthMm" IS NULL OR "contentLengthMm" BETWEEN 50 AND "heightMm"));
UPDATE "PrinterProfile" SET "confirmedAt" = NULL, "confirmedById" = NULL;

