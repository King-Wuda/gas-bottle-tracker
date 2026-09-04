-- AlterTable
ALTER TABLE "ReturnRecord" ADD COLUMN     "driverIdNumber" TEXT,
ADD COLUMN     "driverIdOverridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "driverIdPath" TEXT;
