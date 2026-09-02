import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { prisma, Prisma } from '../db.js';

/** Accepts either the root client or an interactive-transaction client. */
type Db = Prisma.TransactionClient;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 256 bits of entropy, URL-safe. The raw value is returned to the client ONCE;
 *  only its hash is stored. */
function mintOpaqueToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: sha256(raw) };
}

export async function issueRefreshToken(userId: string, db: Db = prisma): Promise<string> {
  const { raw, hash } = mintOpaqueToken();
  const expiresAt = new Date(Date.now() + env().JWT_REFRESH_TTL * 1000);
  await db.refreshToken.create({ data: { userId, tokenHash: hash, expiresAt } });
  return raw;
}

export type RotateResult =
  | { ok: true; userId: string; refreshToken: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' };

/**
 * Single-use rotation: atomically consume the presented token and mint a fresh one
 * for the same user.
 *
 * The consume MUST be a single conditional UPDATE, not read-then-write. Under READ
 * COMMITTED a `findUnique` + `update` by primary key lets N concurrent callers all
 * observe `revokedAt = null` and all succeed, forking N live token families from one
 * stolen token. Putting `revokedAt IS NULL` in the UPDATE predicate makes Postgres
 * re-evaluate it against the freshly committed row, so exactly one caller wins.
 */
export async function rotateRefreshToken(presented: string): Promise<RotateResult> {
  const hash = sha256(presented);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.$queryRaw<{ userId: string }[]>`
      UPDATE "RefreshToken"
      SET "revokedAt" = now()
      WHERE "tokenHash" = ${hash}
        AND "revokedAt" IS NULL
        AND "expiresAt" > now()
      RETURNING "userId"
    `;

    if (claimed.length !== 1) {
      // Lost the race, already used, expired, or never existed. Disambiguate for the
      // log/response only — the security decision was made by the UPDATE above.
      const row = await tx.refreshToken.findUnique({ where: { tokenHash: hash } });
      if (!row) return { ok: false, reason: 'not_found' as const };
      if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' as const };
      return { ok: false, reason: 'revoked' as const };
    }

    const userId = claimed[0]!.userId;
    const refreshToken = await issueRefreshToken(userId, tx);
    return { ok: true as const, userId, refreshToken };
  });
}

/** Idempotent: revoking an unknown or already-revoked token is a no-op success. */
export async function revokeRefreshToken(presented: string): Promise<void> {
  const hash = sha256(presented);
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
