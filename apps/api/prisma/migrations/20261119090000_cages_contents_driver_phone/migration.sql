-- Stores cages, full/empty cylinders, the driver's phone number, and transfer emails.
--
-- Nothing here rewrites existing data. Every cylinder already booked in is FULL (the
-- column default — which is what booking in has always meant), and every cylinder
-- already in stores has no cage yet: the console shows those as "no cage recorded"
-- until they next move, rather than pretending to know where they are.

-- CreateEnum
CREATE TYPE "CylinderContents" AS ENUM ('FULL', 'EMPTY');

-- AlterEnum
ALTER TYPE "EmailType" ADD VALUE 'TRANSFER_NOTICE';

-- AlterTable
ALTER TABLE "Cylinder" ADD COLUMN     "cage" INTEGER,
ADD COLUMN     "contents" "CylinderContents" NOT NULL DEFAULT 'FULL';

-- AlterTable
ALTER TABLE "MovementEvent" ADD COLUMN     "cage" INTEGER,
ADD COLUMN     "contents" "CylinderContents";

-- AlterTable
ALTER TABLE "ReturnRecord" ADD COLUMN     "driverPhone" TEXT;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "driverPhone" TEXT;

-- CreateIndex
CREATE INDEX "Cylinder_gasTypeId_status_cage_contents_idx" ON "Cylinder"("gasTypeId", "status", "cage", "contents");


-- A cage is 1, 2 or 3, and only a cylinder sitting in stores is in one. Without this a
-- transfer that forgot to clear it would leave a cylinder "in cage 2" while it is on a
-- truck to Durban, and the stores console would count it twice.
ALTER TABLE "Cylinder" ADD CONSTRAINT "Cylinder_cage_only_in_stores"
  CHECK ("cage" IS NULL OR ("cage" BETWEEN 1 AND 3 AND "status" = 'IN_STORES'));

ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_cage_range"
  CHECK ("cage" IS NULL OR "cage" BETWEEN 1 AND 3);
