-- Driver profiles: regular collection drivers picked instead of re-typed. Transfers and
-- returns copy the driver's name, email and phone; driverId only links the profile,
-- and is set NULL if the profile is deleted (the copied details stay).
-- AlterTable
ALTER TABLE "ReturnRecord" ADD COLUMN     "driverEmail" TEXT,
ADD COLUMN     "driverId" TEXT;

-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "driverEmail" TEXT,
ADD COLUMN     "driverId" TEXT;

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "surname" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Driver_email_key" ON "Driver"("email");

-- CreateIndex
CREATE INDEX "Driver_active_idx" ON "Driver"("active");

-- CreateIndex
CREATE INDEX "ReturnRecord_driverId_idx" ON "ReturnRecord"("driverId");

-- CreateIndex
CREATE INDEX "Transfer_driverId_idx" ON "Transfer"("driverId");

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRecord" ADD CONSTRAINT "ReturnRecord_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

