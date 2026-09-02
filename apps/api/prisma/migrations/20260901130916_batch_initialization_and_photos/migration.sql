-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'INITIALIZE';

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "initializedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "MovementEvent" ADD COLUMN     "initializationId" TEXT;

-- AlterTable
ALTER TABLE "ReturnRecord" ADD COLUMN     "photoOverridden" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "photoOverridden" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BatchInitialization" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "photoOverridden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BatchInitialization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchPhoto" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracyM" DOUBLE PRECISION,
    "locationError" TEXT,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "serverAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "initializationId" TEXT,
    "transferId" TEXT,
    "returnRecordId" TEXT,

    CONSTRAINT "BatchPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BatchInitialization_clientRequestId_key" ON "BatchInitialization"("clientRequestId");

-- CreateIndex
CREATE INDEX "BatchInitialization_batchId_idx" ON "BatchInitialization"("batchId");

-- CreateIndex
CREATE INDEX "BatchInitialization_userId_idx" ON "BatchInitialization"("userId");

-- CreateIndex
CREATE INDEX "BatchInitialization_createdAt_idx" ON "BatchInitialization"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BatchPhoto_initializationId_key" ON "BatchPhoto"("initializationId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchPhoto_transferId_key" ON "BatchPhoto"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchPhoto_returnRecordId_key" ON "BatchPhoto"("returnRecordId");

-- CreateIndex
CREATE INDEX "BatchPhoto_batchId_idx" ON "BatchPhoto"("batchId");

-- CreateIndex
CREATE INDEX "BatchPhoto_userId_idx" ON "BatchPhoto"("userId");

-- CreateIndex
CREATE INDEX "MovementEvent_initializationId_idx" ON "MovementEvent"("initializationId");

-- AddForeignKey
ALTER TABLE "MovementEvent" ADD CONSTRAINT "MovementEvent_initializationId_fkey" FOREIGN KEY ("initializationId") REFERENCES "BatchInitialization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchInitialization" ADD CONSTRAINT "BatchInitialization_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchInitialization" ADD CONSTRAINT "BatchInitialization_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchPhoto" ADD CONSTRAINT "BatchPhoto_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchPhoto" ADD CONSTRAINT "BatchPhoto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchPhoto" ADD CONSTRAINT "BatchPhoto_initializationId_fkey" FOREIGN KEY ("initializationId") REFERENCES "BatchInitialization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchPhoto" ADD CONSTRAINT "BatchPhoto_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchPhoto" ADD CONSTRAINT "BatchPhoto_returnRecordId_fkey" FOREIGN KEY ("returnRecordId") REFERENCES "ReturnRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A photo is evidence FOR a particular claim, so it must belong to exactly one event.
-- The three @unique indexes above already stop two events sharing a photo; they do not
-- stop a photo owning none of them, or all three. Prisma's schema language cannot
-- express that, and the API is reachable without the app, so it is a CHECK — the same
-- reasoning as the Project number format constraint (see README).
ALTER TABLE "BatchPhoto" ADD CONSTRAINT "BatchPhoto_exactly_one_owner" CHECK (
  (("initializationId" IS NOT NULL)::int
   + ("transferId" IS NOT NULL)::int
   + ("returnRecordId" IS NOT NULL)::int) = 1
);
