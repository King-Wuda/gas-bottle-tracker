-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'SUBCONTRACTOR';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "company" TEXT;
