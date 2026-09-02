-- Website change spec: project-number format, supplier catalogue, delivery-point
-- toggle, timestamptz creation time, transfer/return audit stamps, mail accounting.
--
-- Prisma authored the ALTER/CREATE below; the backfills and the CHECK constraints are
-- hand-written (Prisma cannot express a CHECK in schema.prisma). The trgm/CHECK
-- precedent is 20260827191106_search_and_constraints.

-- ---------------------------------------------------------------- new tables
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GasSupplier" (
    "gasTypeId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GasSupplier_pkey" PRIMARY KEY ("gasTypeId","supplierId")
);

CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");
CREATE INDEX "Supplier_active_idx" ON "Supplier"("active");
CREATE INDEX "GasSupplier_supplierId_idx" ON "GasSupplier"("supplierId");

ALTER TABLE "GasSupplier" ADD CONSTRAINT "GasSupplier_gasTypeId_fkey"
  FOREIGN KEY ("gasTypeId") REFERENCES "GasType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GasSupplier" ADD CONSTRAINT "GasSupplier_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- Batch columns
-- projectManagerEmail arrives NULLable so existing rows can be backfilled from the
-- project's current manager, then tightened to NOT NULL. Adding it NOT NULL outright
-- is what Prisma warned about and would abort on any non-empty table.
ALTER TABLE "Batch"
  ADD COLUMN "supplierId"          TEXT,
  ADD COLUMN "projectManagerEmail" TEXT,
  ADD COLUMN "transferredAt"       TIMESTAMPTZ(3),
  ADD COLUMN "returnedAt"          TIMESTAMPTZ(3),
  ADD COLUMN "emailSentAt"         TIMESTAMPTZ(3),
  ADD COLUMN "lastEmailSentAt"     TIMESTAMPTZ(3),
  ADD COLUMN "resendCount"         INTEGER NOT NULL DEFAULT 0;

-- Existing values are already UTC instants (Prisma writes UTC into timestamp), so the
-- cast reinterprets them at UTC rather than at the server's local zone.
ALTER TABLE "Batch"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

-- Backfill: the address each historical batch would have mailed.
UPDATE "Batch" b
SET "projectManagerEmail" = pm."email"
FROM "Project" p
JOIN "ProjectManager" pm ON pm."id" = p."projectManagerId"
WHERE p."id" = b."projectId" AND b."projectManagerEmail" IS NULL;

ALTER TABLE "Batch" ALTER COLUMN "projectManagerEmail" SET NOT NULL;

-- Backfill the movement stamps from the records that already prove them: the first
-- transfer a batch had, and — only for batches whose derived status says every
-- cylinder is back — its last return.
UPDATE "Batch" b
SET "transferredAt" = t."first"
FROM (SELECT "batchId", MIN("createdAt") AS "first" FROM "Transfer" GROUP BY "batchId") t
WHERE t."batchId" = b."id";

UPDATE "Batch" b
SET "returnedAt" = r."last"
FROM (SELECT "batchId", MAX("createdAt") AS "last" FROM "ReturnRecord" GROUP BY "batchId") r
WHERE r."batchId" = b."id" AND b."status" = 'RETURNED';

-- The delivery point becomes a two-value enum. Historical free text is mapped rather
-- than dropped: anything naming the depot is STORES, everything else was a site.
UPDATE "Batch"
SET "initialDeliveryPoint" = CASE
  WHEN upper("initialDeliveryPoint") LIKE '%STORE%' OR upper("initialDeliveryPoint") LIKE '%DEPOT%'
    THEN 'STORES'
  ELSE 'SITE'
END
WHERE "initialDeliveryPoint" NOT IN ('STORES', 'SITE');

CREATE INDEX "Batch_supplierId_idx" ON "Batch"("supplierId");
CREATE INDEX "Batch_createdAt_idx" ON "Batch"("createdAt" DESC);

ALTER TABLE "Batch" ADD CONSTRAINT "Batch_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------- CHECK constraints
-- Client validation cannot stop a bad row: the API is reachable without the app, and
-- the app is a static export that can be stale. These are the backstop.

ALTER TABLE "Batch"
  ADD CONSTRAINT "Batch_initialDeliveryPoint_enum"
  CHECK ("initialDeliveryPoint" IN ('STORES', 'SITE'));

-- NOT VALID deliberately: it enforces the format on every INSERT and UPDATE from here
-- on, without rejecting project numbers already recorded under the old free-text rule.
-- Rewriting those to fit would be inventing data. To adopt it fully once the existing
-- numbers have been migrated by hand:
--   ALTER TABLE "Project" VALIDATE CONSTRAINT "Project_projectNumber_format";
ALTER TABLE "Project"
  ADD CONSTRAINT "Project_projectNumber_format"
  CHECK ("projectNumber" ~ '^[0-9]{6}-[0-9]{3}-[0-9]{1}-[0-9]{2}$') NOT VALID;
