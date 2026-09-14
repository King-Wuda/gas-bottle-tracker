-- Sites move from PROJECTS to CLIENTS.
--
-- Before this, a Site belonged to a Project: "Delmas" under project 4521 and "Delmas"
-- under project 4522 were two unrelated rows that happened to share a spelling.
-- Nothing could answer "which sites does McCains have?", every new project re-typed
-- them, and a misspelling was invisible forever. Now a Client owns its sites, a
-- Project is a job FOR a client, and both projects point at the same Durban row.
--
-- ============================ THIS MIGRATION DESTROYS DATA ====================
-- `Site.clientId` and `Project.clientId` are NOT NULL and there is no honest way to
-- derive them: the old schema never recorded which client a site belonged to, only
-- which project re-typed it. Inventing one client per project would manufacture a
-- directory full of duplicates — exactly the problem this change exists to remove.
--
-- So the operational data goes first. This was a deliberate decision, taken while the
-- batches in the database were test data. If you are applying this to an installation
-- with deliveries you care about, STOP: restore a dump, and write a backfill that maps
-- your real sites to real clients before running it.
--
-- The catalogue survives: users, project managers, gas types and suppliers are all
-- untouched. Re-seed with `npm run -w @gct/api db:seed` afterwards.
--
-- The delete order below is load-bearing, for the same reason as
-- `apps/api/scripts/reset-data.ts` and `services/adminDelete.ts`: every foreign key in
-- this schema is Restrict, so a wrong order does not cascade — it fails halfway.
-- =============================================================================

DELETE FROM "BatchPhoto";
DELETE FROM "MovementEvent";
DELETE FROM "Transfer";
DELETE FROM "ReturnRecord";
DELETE FROM "BatchInitialization";
DELETE FROM "Cylinder";
DELETE FROM "BatchLine";
DELETE FROM "BatchAmendment";
DELETE FROM "OutboundEmail";
DELETE FROM "Batch";
DELETE FROM "Site";
DELETE FROM "Project";
-- Blobs for the rows above: signatures, ID photographs, batch photos, delivery notes.
-- Under STORAGE_DRIVER=fs these live on disk instead and are left behind harmlessly;
-- under `db` they are rows here, and keeping them would orphan them permanently.
DELETE FROM "StoredFile";
-- Serial counters restart: the batches those numbers belonged to no longer exist, so
-- resuming mid-sequence would issue serials that look like they belong to something.
DELETE FROM "SerialSequence";

-- DropIndex
DROP INDEX "Site_projectId_name_key";

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "clientId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ProjectManager" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Site" DROP COLUMN "name",
DROP COLUMN "projectId",
ADD COLUMN     "clientId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_name_key" ON "Client"("name");

-- CreateIndex
CREATE INDEX "Client_active_idx" ON "Client"("active");

-- CreateIndex
CREATE INDEX "Client_name_trgm_idx" ON "Client" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Project_clientId_idx" ON "Project"("clientId");

-- CreateIndex
CREATE INDEX "Site_clientId_idx" ON "Site"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_clientId_location_key" ON "Site"("clientId", "location");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
