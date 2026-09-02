-- AlterTable
ALTER TABLE "MovementEvent" ADD COLUMN     "returnRecordId" TEXT;

-- CreateIndex
CREATE INDEX "MovementEvent_returnRecordId_idx" ON "MovementEvent"("returnRecordId");

-- AddForeignKey
ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_returnRecordId_fkey" FOREIGN KEY ("returnRecordId") REFERENCES "ReturnRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
