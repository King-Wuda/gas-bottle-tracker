-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TECHNICIAN', 'STORES_MANAGER', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('ACTIVE', 'PARTIAL', 'RETURNED');

-- CreateEnum
CREATE TYPE "CylinderStatus" AS ENUM ('IN_STORES', 'DEPLOYED', 'IN_TRANSIT', 'RETURNED');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('INTAKE', 'TRANSFER', 'RETURN');

-- CreateEnum
CREATE TYPE "DestinationType" AS ENUM ('SITE', 'STORES');

-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('QR_SHEET', 'DELIVERY_NOTE');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectManager" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectManager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "projectNumber" TEXT NOT NULL,
    "projectManagerId" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GasType" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GasType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerialSequence" (
    "prefix" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SerialSequence_pkey" PRIMARY KEY ("prefix","year")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "gasTypeId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "initialDeliveryPoint" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'ACTIVE',
    "clientRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cylinder" (
    "id" TEXT NOT NULL,
    "serialCode" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "gasTypeId" TEXT NOT NULL,
    "status" "CylinderStatus" NOT NULL DEFAULT 'IN_STORES',
    "currentSiteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cylinder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MovementEvent" (
    "id" TEXT NOT NULL,
    "cylinderId" TEXT NOT NULL,
    "type" "MovementType" NOT NULL,
    "fromSiteId" TEXT,
    "toSiteId" TEXT,
    "userId" TEXT NOT NULL,
    "deviceAt" TIMESTAMP(3) NOT NULL,
    "serverAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MovementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "destinationType" "DestinationType" NOT NULL,
    "destinationSiteId" TEXT,
    "userId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "storesManagerId" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "signaturePath" TEXT NOT NULL,
    "deliveryNotePath" TEXT,
    "clientRequestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundEmail" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "type" "EmailType" NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "attachmentPaths" TEXT[],
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectManager_email_key" ON "ProjectManager"("email");

-- CreateIndex
CREATE INDEX "ProjectManager_name_idx" ON "ProjectManager"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_projectNumber_key" ON "Project"("projectNumber");

-- CreateIndex
CREATE INDEX "Project_projectManagerId_idx" ON "Project"("projectManagerId");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Site_projectId_idx" ON "Site"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_projectId_name_key" ON "Site"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GasType_name_key" ON "GasType"("name");

-- CreateIndex
CREATE UNIQUE INDEX "GasType_prefix_key" ON "GasType"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "Batch_clientRequestId_key" ON "Batch"("clientRequestId");

-- CreateIndex
CREATE INDEX "Batch_projectId_status_idx" ON "Batch"("projectId", "status");

-- CreateIndex
CREATE INDEX "Batch_siteId_idx" ON "Batch"("siteId");

-- CreateIndex
CREATE INDEX "Batch_gasTypeId_idx" ON "Batch"("gasTypeId");

-- CreateIndex
CREATE INDEX "Batch_createdByUserId_idx" ON "Batch"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Cylinder_serialCode_key" ON "Cylinder"("serialCode");

-- CreateIndex
CREATE INDEX "Cylinder_batchId_idx" ON "Cylinder"("batchId");

-- CreateIndex
CREATE INDEX "Cylinder_batchId_status_idx" ON "Cylinder"("batchId", "status");

-- CreateIndex
CREATE INDEX "Cylinder_currentSiteId_idx" ON "Cylinder"("currentSiteId");

-- CreateIndex
CREATE INDEX "Cylinder_gasTypeId_idx" ON "Cylinder"("gasTypeId");

-- CreateIndex
CREATE INDEX "MovementEvent_cylinderId_idx" ON "MovementEvent"("cylinderId");

-- CreateIndex
CREATE INDEX "MovementEvent_cylinderId_serverAt_idx" ON "MovementEvent"("cylinderId", "serverAt");

-- CreateIndex
CREATE INDEX "MovementEvent_userId_idx" ON "MovementEvent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Transfer_clientRequestId_key" ON "Transfer"("clientRequestId");

-- CreateIndex
CREATE INDEX "Transfer_batchId_idx" ON "Transfer"("batchId");

-- CreateIndex
CREATE INDEX "Transfer_userId_idx" ON "Transfer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRecord_clientRequestId_key" ON "ReturnRecord"("clientRequestId");

-- CreateIndex
CREATE INDEX "ReturnRecord_batchId_idx" ON "ReturnRecord"("batchId");

-- CreateIndex
CREATE INDEX "ReturnRecord_storesManagerId_idx" ON "ReturnRecord"("storesManagerId");

-- CreateIndex
CREATE INDEX "OutboundEmail_status_idx" ON "OutboundEmail"("status");

-- CreateIndex
CREATE INDEX "OutboundEmail_status_createdAt_idx" ON "OutboundEmail"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_projectManagerId_fkey" FOREIGN KEY ("projectManagerId") REFERENCES "ProjectManager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_gasTypeId_fkey" FOREIGN KEY ("gasTypeId") REFERENCES "GasType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cylinder" ADD CONSTRAINT "Cylinder_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cylinder" ADD CONSTRAINT "Cylinder_gasTypeId_fkey" FOREIGN KEY ("gasTypeId") REFERENCES "GasType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cylinder" ADD CONSTRAINT "Cylinder_currentSiteId_fkey" FOREIGN KEY ("currentSiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_cylinderId_fkey" FOREIGN KEY ("cylinderId") REFERENCES "Cylinder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_fromSiteId_fkey" FOREIGN KEY ("fromSiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_toSiteId_fkey" FOREIGN KEY ("toSiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_destinationSiteId_fkey" FOREIGN KEY ("destinationSiteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_storesManagerId_fkey" FOREIGN KEY ("storesManagerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
