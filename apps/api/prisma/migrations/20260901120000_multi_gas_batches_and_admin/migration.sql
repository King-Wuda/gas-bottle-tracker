-- Multi-gas batches, reassignable project managers, scan overrides, admin console.
--
-- The structural move: a Batch stops being "7 nitrogen from Afrox" and becomes a
-- delivery that HAS lines, one of which is 7 nitrogen from Afrox. Existing batches are
-- preserved by giving each exactly one line carrying its current gas/supplier/quantity,
-- so no row is dropped and every cylinder keeps a line to point at.

-- ----------------------------------------------------------------- project managers
ALTER TABLE "ProjectManager" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "ProjectManager_active_idx" ON "ProjectManager"("active");

-- ----------------------------------------------------------------- batch lines
CREATE TABLE "BatchLine" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "gasTypeId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "initialDeliveryPoint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BatchLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BatchLine_batchId_idx" ON "BatchLine"("batchId");
CREATE INDEX "BatchLine_gasTypeId_idx" ON "BatchLine"("gasTypeId");
CREATE INDEX "BatchLine_supplierId_idx" ON "BatchLine"("supplierId");

ALTER TABLE "BatchLine" ADD CONSTRAINT "BatchLine_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BatchLine" ADD CONSTRAINT "BatchLine_gasTypeId_fkey"
  FOREIGN KEY ("gasTypeId") REFERENCES "GasType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BatchLine" ADD CONSTRAINT "BatchLine_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The same enum guard the dropped Batch column carried.
ALTER TABLE "BatchLine" ADD CONSTRAINT "BatchLine_initialDeliveryPoint_enum"
  CHECK ("initialDeliveryPoint" IN ('STORES', 'SITE'));

-- Backfill: one line per existing batch, from the columns about to be dropped.
INSERT INTO "BatchLine" (
  "id", "batchId", "gasTypeId", "supplierId", "supplierName",
  "quantity", "initialDeliveryPoint", "createdAt", "updatedAt"
)
SELECT
  'bl_' || "id", "id", "gasTypeId", "supplierId", "supplierName",
  "quantity", "initialDeliveryPoint", "createdAt", now()
FROM "Batch";

-- ----------------------------------------------------------------- cylinders -> lines
ALTER TABLE "Cylinder" ADD COLUMN "batchLineId" TEXT;
UPDATE "Cylinder" SET "batchLineId" = 'bl_' || "batchId";
ALTER TABLE "Cylinder" ALTER COLUMN "batchLineId" SET NOT NULL;

ALTER TABLE "Cylinder" ADD CONSTRAINT "Cylinder_batchLineId_fkey"
  FOREIGN KEY ("batchLineId") REFERENCES "BatchLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Cylinder_batchLineId_idx" ON "Cylinder"("batchLineId");
-- Exactly the grouping the per-gas location breakdown reads.
CREATE INDEX "Cylinder_batchId_batchLineId_currentSiteId_status_idx"
  ON "Cylinder"("batchId", "batchLineId", "currentSiteId", "status");

-- ----------------------------------------------------------------- batch reshape
-- projectManagerId becomes a real column so a batch can be reassigned without
-- touching its project. Backfilled from the project's manager, which is exactly what
-- the old indirection resolved to.
ALTER TABLE "Batch" ADD COLUMN "projectManagerId" TEXT;
UPDATE "Batch" b
SET "projectManagerId" = p."projectManagerId"
FROM "Project" p
WHERE p."id" = b."projectId";
ALTER TABLE "Batch" ALTER COLUMN "projectManagerId" SET NOT NULL;

ALTER TABLE "Batch" ADD CONSTRAINT "Batch_projectManagerId_fkey"
  FOREIGN KEY ("projectManagerId") REFERENCES "ProjectManager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Batch_projectManagerId_idx" ON "Batch"("projectManagerId");

-- The gas-specific columns now live on BatchLine.
DROP INDEX IF EXISTS "Batch_gasTypeId_idx";
DROP INDEX IF EXISTS "Batch_supplierId_idx";
ALTER TABLE "Batch" DROP CONSTRAINT IF EXISTS "Batch_gasTypeId_fkey";
ALTER TABLE "Batch" DROP CONSTRAINT IF EXISTS "Batch_supplierId_fkey";
ALTER TABLE "Batch" DROP CONSTRAINT IF EXISTS "Batch_initialDeliveryPoint_enum";
ALTER TABLE "Batch" DROP CONSTRAINT IF EXISTS "Batch_quantity_positive";
ALTER TABLE "Batch"
  DROP COLUMN "gasTypeId",
  DROP COLUMN "supplierId",
  DROP COLUMN "supplierName",
  DROP COLUMN "quantity",
  DROP COLUMN "initialDeliveryPoint";

-- ----------------------------------------------------------------- scan overrides
ALTER TABLE "MovementEvent" ADD COLUMN "overridden" BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------------- transfer hands over the PM
ALTER TABLE "Transfer" ADD COLUMN "projectManagerId" TEXT;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_projectManagerId_fkey"
  FOREIGN KEY ("projectManagerId") REFERENCES "ProjectManager"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Transfer_projectManagerId_idx" ON "Transfer"("projectManagerId");

-- ----------------------------------------------------------------- amendment log
CREATE TABLE "BatchAmendment" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BatchAmendment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BatchAmendment_batchId_createdAt_idx" ON "BatchAmendment"("batchId", "createdAt" DESC);
CREATE INDEX "BatchAmendment_userId_idx" ON "BatchAmendment"("userId");

ALTER TABLE "BatchAmendment" ADD CONSTRAINT "BatchAmendment_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BatchAmendment" ADD CONSTRAINT "BatchAmendment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
