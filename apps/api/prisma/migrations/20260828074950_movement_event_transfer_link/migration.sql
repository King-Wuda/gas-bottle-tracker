-- AlterTable
ALTER TABLE "MovementEvent" ADD COLUMN     "transferId" TEXT;

-- CreateIndex
CREATE INDEX "MovementEvent_transferId_idx" ON "MovementEvent"("transferId");

-- AddForeignKey
ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
