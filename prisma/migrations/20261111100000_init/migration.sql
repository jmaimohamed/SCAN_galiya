-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "BoxStatus" AS ENUM ('IN_PROGRESS', 'OK', 'NOK');

-- CreateEnum
CREATE TYPE "ScanOutcome" AS ENUM ('ACCEPTED', 'INVALID_FORMAT', 'WRONG_PART_NUMBER', 'DUPLICATE_SAME_BOX', 'DUPLICATE_OTHER_BOX', 'QUANTITY_REACHED', 'BOX_NOT_IN_PROGRESS', 'NOT_BOX_OWNER');

-- CreateEnum
CREATE TYPE "PrintJobType" AS ENUM ('ORIGINAL', 'REPRINT', 'TEST');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('CREATED', 'DISPATCHING', 'SENT_TO_PRINTER', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) NOT NULL,
    "displayName" VARCHAR(80),
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastLoginAt" TIMESTAMPTZ(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" CHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "ip" VARCHAR(64),
    "userAgent" VARCHAR(256),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" BIGSERIAL NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "ip" VARCHAR(64) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Box" (
    "id" UUID NOT NULL,
    "boxSerial" VARCHAR(30) NOT NULL,
    "partNumber" VARCHAR(40) NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "galiaPayload" VARCHAR(128) NOT NULL,
    "status" "BoxStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerUserId" UUID,
    "ownerSessionId" CHAR(64),
    "leaseTokenHash" CHAR(64),
    "ownerSince" TIMESTAMPTZ(3),
    "finalizedAt" TIMESTAMPTZ(3),
    "finalizedById" UUID,

    CONSTRAINT "Box_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanAttempt" (
    "id" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "boxId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" CHAR(64) NOT NULL,
    "rawPayload" VARCHAR(160) NOT NULL,
    "rawLength" INTEGER NOT NULL,
    "partNumber" VARCHAR(40),
    "serial" VARCHAR(30),
    "outcome" "ScanOutcome" NOT NULL,
    "errorCode" VARCHAR(40),
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcceptedItem" (
    "id" UUID NOT NULL,
    "serial" VARCHAR(30) NOT NULL,
    "partNumber" VARCHAR(40) NOT NULL,
    "rawPayload" VARCHAR(128) NOT NULL,
    "boxId" UUID NOT NULL,
    "acceptedById" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcceptedItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "boxId" UUID NOT NULL,
    "result" "BoxStatus" NOT NULL,
    "boxSerial" VARCHAR(30) NOT NULL,
    "partNumber" VARCHAR(40) NOT NULL,
    "galiaPayload" VARCHAR(128) NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "acceptedQty" INTEGER NOT NULL,
    "difference" INTEGER NOT NULL,
    "issues" TEXT[],
    "reason" VARCHAR(500),
    "finalizedById" UUID NOT NULL,
    "finalizedByUsername" VARCHAR(32) NOT NULL,
    "finalizedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrinterProfile" (
    "workstationId" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "printerName" VARCHAR(128),
    "printerUid" VARCHAR(256),
    "printerConnection" VARCHAR(32),
    "widthMm" INTEGER NOT NULL DEFAULT 100,
    "heightMm" INTEGER NOT NULL DEFAULT 100,
    "dpi" INTEGER,
    "accentMode" VARCHAR(8) NOT NULL DEFAULT 'UTF8',
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedById" UUID,

    CONSTRAINT "PrinterProfile_pkey" PRIMARY KEY ("workstationId")
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "type" "PrintJobType" NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'CREATED',
    "reportId" UUID,
    "originalJobId" UUID,
    "requestedById" UUID NOT NULL,
    "requestedByUsername" VARCHAR(32) NOT NULL,
    "sessionId" CHAR(64) NOT NULL,
    "workstationId" UUID NOT NULL,
    "workstationName" VARCHAR(64),
    "printerName" VARCHAR(128) NOT NULL,
    "printerUid" VARCHAR(256) NOT NULL,
    "widthMm" INTEGER NOT NULL,
    "heightMm" INTEGER NOT NULL,
    "dpi" INTEGER NOT NULL,
    "accentMode" VARCHAR(8) NOT NULL,
    "templateVersion" VARCHAR(32) NOT NULL,
    "reprintReason" VARCHAR(200),
    "payload" TEXT NOT NULL,
    "payloadSha256" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(3),
    "claimedBySessionId" CHAR(64),
    "sentAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "errorMessage" VARCHAR(500),

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "type" VARCHAR(40) NOT NULL,
    "userId" UUID,
    "username" VARCHAR(32),
    "sessionId" CHAR(64),
    "boxId" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "LoginAttempt_username_createdAt_idx" ON "LoginAttempt"("username", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ip_createdAt_idx" ON "LoginAttempt"("ip", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Box_boxSerial_key" ON "Box"("boxSerial");

-- CreateIndex
CREATE INDEX "Box_createdAt_idx" ON "Box"("createdAt");

-- CreateIndex
CREATE INDEX "Box_status_createdAt_idx" ON "Box"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Box_partNumber_idx" ON "Box"("partNumber");

-- CreateIndex
CREATE INDEX "Box_ownerUserId_idx" ON "Box"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanAttempt_idempotencyKey_key" ON "ScanAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ScanAttempt_boxId_createdAt_idx" ON "ScanAttempt"("boxId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanAttempt_serial_idx" ON "ScanAttempt"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "AcceptedItem_serial_key" ON "AcceptedItem"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "AcceptedItem_attemptId_key" ON "AcceptedItem"("attemptId");

-- CreateIndex
CREATE INDEX "AcceptedItem_boxId_acceptedAt_idx" ON "AcceptedItem"("boxId", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Report_number_key" ON "Report"("number");

-- CreateIndex
CREATE UNIQUE INDEX "Report_boxId_key" ON "Report"("boxId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_idempotencyKey_key" ON "PrintJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PrintJob_reportId_createdAt_idx" ON "PrintJob"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "PrintJob_status_createdAt_idx" ON "PrintJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_boxId_createdAt_idx" ON "AuditEvent"("boxId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_type_createdAt_idx" ON "AuditEvent"("type", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Box" ADD CONSTRAINT "Box_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Box" ADD CONSTRAINT "Box_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanAttempt" ADD CONSTRAINT "ScanAttempt_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanAttempt" ADD CONSTRAINT "ScanAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcceptedItem" ADD CONSTRAINT "AcceptedItem_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcceptedItem" ADD CONSTRAINT "AcceptedItem_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcceptedItem" ADD CONSTRAINT "AcceptedItem_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "ScanAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
