-- pg_trgm is also created in 20260827191106_search_and_constraints; kept here so this
-- migration is self-contained if that one is ever squashed.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "Project_projectNumber_trgm_idx" ON "Project" USING GIN ("projectNumber" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ProjectManager_name_trgm_idx" ON "ProjectManager" USING GIN ("name" gin_trgm_ops);
