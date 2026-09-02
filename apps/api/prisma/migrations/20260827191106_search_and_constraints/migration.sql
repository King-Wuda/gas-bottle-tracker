-- Hand-written migration (Prisma cannot express these in-schema without preview flags).

-- 1. Substring/ILIKE search for GET /projects?q= (Workflow B1 / C1):
--    prisma.project.findMany({ where: { OR: [
--      { projectNumber:            { contains: q, mode: 'insensitive' } },
--      { projectManager: { is: { name: { contains: q, mode: 'insensitive' } } } },
--    ]}})
--    { contains, insensitive } compiles to ILIKE '%q%', which no btree index can serve.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Project_projectNumber_trgm_idx"
  ON "Project" USING gin ("projectNumber" gin_trgm_ops);

CREATE INDEX "ProjectManager_name_trgm_idx"
  ON "ProjectManager" USING gin ("name" gin_trgm_ops);

-- 2. Serial counter can never go negative.
ALTER TABLE "SerialSequence"
  ADD CONSTRAINT "SerialSequence_lastSeq_nonneg" CHECK ("lastSeq" >= 0);

-- 3. Defence-in-depth for the Cylinder.currentSiteId <-> status invariant
--    (the service layer is the primary enforcer).
ALTER TABLE "Cylinder"
  ADD CONSTRAINT "Cylinder_instores_no_site"
  CHECK ("status" <> 'IN_STORES' OR "currentSiteId" IS NULL);

ALTER TABLE "Cylinder"
  ADD CONSTRAINT "Cylinder_returned_no_site"
  CHECK ("status" <> 'RETURNED' OR "currentSiteId" IS NULL);

ALTER TABLE "Cylinder"
  ADD CONSTRAINT "Cylinder_deployed_has_site"
  CHECK ("status" <> 'DEPLOYED' OR "currentSiteId" IS NOT NULL);
