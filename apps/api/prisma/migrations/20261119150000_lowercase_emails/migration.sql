-- Sign-in compares email addresses without regard to case (see loginEmailSchema), and
-- the admin console has always lowercased addresses on the way in. This brings any
-- address stored with capitals or stray spaces into line, so every account and every
-- project manager record holds the same canonical form the login looks up.
--
-- A row is left as it is if lowercasing it would collide with another row's address:
-- two accounts that differ only by case cannot both become the same address under the
-- unique index, and choosing which one survives is a person's decision, not a
-- migration's. The login still finds such an account (its lookup is case-insensitive).

UPDATE "User" AS u
SET "email" = lower(btrim(u."email"))
WHERE u."email" <> lower(btrim(u."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "User" AS o
    WHERE o."id" <> u."id" AND lower(btrim(o."email")) = lower(btrim(u."email"))
  );

UPDATE "ProjectManager" AS p
SET "email" = lower(btrim(p."email"))
WHERE p."email" <> lower(btrim(p."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "ProjectManager" AS o
    WHERE o."id" <> p."id" AND lower(btrim(o."email")) = lower(btrim(p."email"))
  );
