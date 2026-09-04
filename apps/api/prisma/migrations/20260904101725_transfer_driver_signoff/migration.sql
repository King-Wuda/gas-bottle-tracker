-- AlterTable
ALTER TABLE "Transfer" ADD COLUMN     "driverIdNumber" TEXT,
ADD COLUMN     "driverIdOverridden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "driverIdPath" TEXT,
ADD COLUMN     "driverName" TEXT,
ADD COLUMN     "signaturePath" TEXT;
