-- Every account's password becomes `gea`, the default every new profile starts with.
--
-- Asked for directly: for now everyone signs in with `gea`, and each person changes their
-- own password from the dashboard ("Change password", POST /me/password). A migration
-- rather than a script so it happens exactly once, on the deploy that ships the
-- change-password screen — a password someone sets afterwards is never reset by it.
--
-- The hash is argon2id('gea'). It is a hash of a password that is published in the
-- README, so there is nothing secret in committing it.
--
-- Deleted accounts are left alone: their password was scrambled on purpose, their
-- address released, and they must never sign in again. Every live session is ended so
-- that a phone signed in under the old password does not carry on as if nothing changed.

UPDATE "User"
SET "passwordHash" = '$argon2id$v=19$m=65536,p=4,t=3$maTWzaYY2Kdg28HwRIxwJA$FC45tOLKg9mLTWPQCEgPpasY/3Syx89iId+kls1lLR0',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "deletedAt" IS NULL;

UPDATE "RefreshToken" rt
SET "revokedAt" = CURRENT_TIMESTAMP
FROM "User" u
WHERE rt."userId" = u."id" AND u."deletedAt" IS NULL AND rt."revokedAt" IS NULL;
