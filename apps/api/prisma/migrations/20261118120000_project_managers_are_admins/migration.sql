-- Project managers ARE the admins.
--
-- Before: an ADMIN `User` (a login that runs the console) and a `ProjectManager` (an
-- email address paperwork is sent to) were unrelated rows — the two owners existed
-- twice, and a project manager could not sign in at all. After: the role is called
-- PROJECT_MANAGER, and every ProjectManager row is backed by exactly one such login.
--
-- Three populations are reconciled, all matched by e-mail (stored lower-case by the
-- API and the seed, compared lower-case here anyway):
--   1. an admin who already has a manager row  -> linked;
--   2. a manager with no login                 -> given one, with the default password
--      `gea` (the hash below is argon2id of it, as every new profile starts with) —
--      the next migration resets every account to it anyway;
--      a deleted manager's login gets no password at all;
--   3. an admin with no manager row            -> given one.
-- A manager whose address matches a technician's or stores manager's login is the same
-- person, and every project manager is now an admin, so that login is promoted.

-- 1. The role itself. RENAME (not ADD) so existing rows and tokens' meaning carry over.
ALTER TYPE "Role" RENAME VALUE 'ADMIN' TO 'PROJECT_MANAGER';

ALTER TABLE "ProjectManager" ADD COLUMN "userId" TEXT;

-- 2. Link managers to the live login that shares their address, promoting it.
UPDATE "ProjectManager" pm
SET "userId" = u."id"
FROM "User" u
WHERE u."deletedAt" IS NULL
  AND lower(u."email") = lower(pm."email");

UPDATE "User" u
SET "role" = 'PROJECT_MANAGER', "updatedAt" = CURRENT_TIMESTAMP
FROM "ProjectManager" pm
WHERE pm."userId" = u."id" AND u."role" <> 'PROJECT_MANAGER';

-- 3. Managers with no login get one. A deleted manager gets a deleted login, so the
--    tombstone stays a tombstone on both sides.
INSERT INTO "User" ("id", "email", "passwordHash", "name", "role", "active", "deletedAt",
                    "createdAt", "updatedAt")
SELECT 'pmu' || substr(md5(pm."id"), 1, 22), lower(pm."email"),
       -- A deleted manager's login must never accept a password, known or not; '!deleted'
       -- is not an argon2 hash, so verify() rejects it outright.
       CASE WHEN pm."deletedAt" IS NULL
            THEN '$argon2id$v=19$m=65536,p=4,t=3$maTWzaYY2Kdg28HwRIxwJA$FC45tOLKg9mLTWPQCEgPpasY/3Syx89iId+kls1lLR0'
            ELSE '!deleted' END,
       pm."name",
       'PROJECT_MANAGER', pm."active", pm."deletedAt", pm."createdAt", CURRENT_TIMESTAMP
FROM "ProjectManager" pm
WHERE pm."userId" IS NULL;

UPDATE "ProjectManager" pm
SET "userId" = 'pmu' || substr(md5(pm."id"), 1, 22)
WHERE pm."userId" IS NULL;

-- 4. Admins (now PROJECT_MANAGER) with no manager row get one, so they can be named on
--    a project and appear in the console's one list. Deleted accounts are skipped:
--    nothing will ever be addressed to them.
INSERT INTO "ProjectManager" ("id", "userId", "name", "email", "active", "createdAt",
                              "updatedAt")
SELECT 'pmr' || substr(md5(u."id"), 1, 22), u."id", u."name", lower(u."email"), u."active",
       u."createdAt", CURRENT_TIMESTAMP
FROM "User" u
WHERE u."role" = 'PROJECT_MANAGER'
  AND u."deletedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "ProjectManager" pm WHERE pm."userId" = u."id");

-- 5. Now that every row has one, the link is required and one-to-one.
ALTER TABLE "ProjectManager" ALTER COLUMN "userId" SET NOT NULL;

CREATE UNIQUE INDEX "ProjectManager_userId_key" ON "ProjectManager"("userId");

ALTER TABLE "ProjectManager" ADD CONSTRAINT "ProjectManager_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
