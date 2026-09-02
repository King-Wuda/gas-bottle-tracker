-- Transfer.projectManagerId is the record of who a batch was handed to. Prisma's
-- default for an optional relation is ON DELETE SET NULL, which would let deleting a
-- manager quietly erase that record. Every other FK in this schema is Restrict, and
-- managers are deactivated rather than deleted, so this one is Restrict too.
ALTER TABLE "Transfer" DROP CONSTRAINT "Transfer_projectManagerId_fkey";
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_projectManagerId_fkey"
  FOREIGN KEY ("projectManagerId") REFERENCES "ProjectManager"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
