-- Superseded, and kept only so databases that already recorded it stay valid.
--
-- This migration was generated to change Transfer.projectManagerId's foreign key to
-- ON DELETE SET NULL. Two things then happened to it:
--
--   * 20260901120000_multi_gas_batches_and_admin — hand-written, and named with a
--     LATER timestamp than this one — is what actually ADDS that column and its
--     constraint. Migrations replay in filename order, not in the order they were
--     first applied, so on a fresh database this file ran first and failed with
--     42704: the constraint it drops did not exist yet. Every `migrate deploy` onto
--     an empty database, and every shadow database `migrate dev` builds, died here.
--   * 20260901130000_transfer_pm_fk_restrict then replaced SET NULL with RESTRICT,
--     because SET NULL would let deleting a project manager silently erase the record
--     of who a batch was handed to.
--
-- So its net effect is nil and its literal form was unreplayable. Deleting the file
-- would invalidate the history of every database that has already applied it, so it is
-- guarded instead: a no-op on a fresh database, byte-for-byte the same outcome on an
-- old one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Transfer_projectManagerId_fkey') THEN
    ALTER TABLE "Transfer" DROP CONSTRAINT "Transfer_projectManagerId_fkey";
    ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_projectManagerId_fkey"
      FOREIGN KEY ("projectManagerId") REFERENCES "ProjectManager"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
