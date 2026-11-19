-- Project numbers are 5-3-1-2 (e.g. 12345-678-9-01), not 6-3-1-2.
--
-- From here on the database refuses any new or changed project number in another
-- shape. It is added NOT VALID because the rows already recorded in the old shape (all
-- test data) are not rewritten — which digit was the extra one is not something a
-- migration can know. They are DELETED instead, with everything on them, by
-- `scripts/remove-legacy-projects.ts`, which the start script runs right after this
-- migration. Once none are left, that script VALIDATEs this constraint, so from then on
-- the database guarantees every project number is 5-3-1-2.

ALTER TABLE "Project" DROP CONSTRAINT IF EXISTS "Project_projectNumber_format";

ALTER TABLE "Project"
  ADD CONSTRAINT "Project_projectNumber_format"
  CHECK ("projectNumber" ~ '^[0-9]{5}-[0-9]{3}-[0-9]{1}-[0-9]{2}$') NOT VALID;
