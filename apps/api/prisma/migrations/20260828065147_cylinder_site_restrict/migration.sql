-- DropForeignKey
ALTER TABLE "Cylinder" DROP CONSTRAINT "Cylinder_currentSiteId_fkey";

-- AddForeignKey
ALTER TABLE "Cylinder" ADD CONSTRAINT "Cylinder_currentSiteId_fkey" FOREIGN KEY ("currentSiteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Transfer has the same status/nullable-FK coupling the Cylinder CHECKs already guard,
-- but had no constraint. Enforce it before M3 starts writing to this table.
ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_site_destination_has_site"
  CHECK ("destinationType" <> 'SITE' OR "destinationSiteId" IS NOT NULL);

ALTER TABLE "Transfer"
  ADD CONSTRAINT "Transfer_stores_destination_has_no_site"
  CHECK ("destinationType" <> 'STORES' OR "destinationSiteId" IS NULL);
