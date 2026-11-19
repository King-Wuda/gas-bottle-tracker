import type { FastifyInstance } from 'fastify';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
  logoutRequestSchema,
  type LoginResponse,
  type RefreshResponse,
  type ChangePasswordResponse,
  type MeResponse,
  type UserDto,
} from '@gct/shared';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { dummyHash, hashPassword, verifyPassword } from '../lib/password.js';
import { issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from '../lib/refreshTokens.js';
import type { AccessTokenClaims } from '../plugins/auth.js';

const toUserDto = (u: {
  id: string;
  email: string;
  name: string;
  role: UserDto['role'];
  company: string | null;
  active: boolean;
}): UserDto => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  company: u.company,
  active: u.active,
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const signAccess = (claims: AccessTokenClaims): string => app.jwt.sign(claims);
  const accessTtl = env().JWT_ACCESS_TTL;

  app.post('/auth/login', async (request, reply) => {
    const { email, password } = loginRequestSchema.parse(request.body);

    // `email` arrives trimmed and lowercased (loginRequestSchema). The lookup is also
    // case-insensitive, so an address stored with capitals — written before addresses
    // were normalised, or by hand — still signs in. Should two rows differ only by case
    // (the migration leaves such a pair alone rather than guess), the exact lowercase one
    // wins, then an active one.
    const candidates = await prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' } },
      orderBy: { createdAt: 'asc' },
    });
    const user =
      candidates.find((u) => u.email === email) ??
      candidates.find((u) => u.active) ??
      candidates[0] ??
      null;
    // Always run one argon2 verify, even for an unknown email, so response time does
    // not reveal whether the account exists (see dummyHash).
    const passwordOk = await verifyPassword(user?.passwordHash ?? (await dummyHash()), password);
    const ok = !!user && user.active && passwordOk;
    if (!user || !ok) {
      return reply.code(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' },
      });
    }

    const accessToken = signAccess({ sub: user.id, role: user.role, name: user.name });
    const refreshToken = await issueRefreshToken(user.id);

    const body: LoginResponse = {
      accessToken,
      refreshToken,
      expiresIn: accessTtl,
      user: toUserDto(user),
    };
    return reply.send(body);
  });

  app.post('/auth/refresh', async (request, reply) => {
    const { refreshToken } = refreshRequestSchema.parse(request.body);

    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated.ok) {
      return reply
        .code(401)
        .send({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is not valid' } });
    }

    const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
    if (!user || !user.active) {
      return reply
        .code(401)
        .send({ error: { code: 'ACCOUNT_INACTIVE', message: 'Account is not active' } });
    }

    const accessToken = signAccess({ sub: user.id, role: user.role, name: user.name });
    const body: RefreshResponse = {
      accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: accessTtl,
    };
    return reply.send(body);
  });

  app.post('/auth/logout', async (request, reply) => {
    const { refreshToken } = logoutRequestSchema.parse(request.body);
    await revokeRefreshToken(refreshToken);
    return reply.code(204).send();
  });

  app.get('/me', { preHandler: app.authenticate }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }
    const body: MeResponse = { user: toUserDto(user) };
    return reply.send(body);
  });

  /**
   * Change your own password — everyone, whatever their role.
   *
   * Asks for the current password even though the caller is signed in: a phone left
   * unlocked must not be enough to take the account over for good. A wrong one is a
   * 400, not a 401 — the session is fine, and a 401 would send the app off to refresh
   * its token and retry the same wrong password.
   *
   * Every session the account holds is ended, because "someone may know my password"
   * is the usual reason to change it. The device that made the change gets a fresh
   * session back instead of being signed out with the rest.
   */
  app.post('/me/password', { preHandler: app.authenticate }, async (request, reply) => {
    const input = changePasswordRequestSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
    if (!user || !user.active || user.deletedAt) {
      return reply
        .code(401)
        .send({ error: { code: 'ACCOUNT_INACTIVE', message: 'Account is not active' } });
    }
    if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
      return reply.code(400).send({
        error: { code: 'WRONG_PASSWORD', message: 'Your current password is not correct.' },
      });
    }

    const passwordHash = await hashPassword(input.newPassword);
    const refreshToken = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return issueRefreshToken(user.id, tx);
    });

    const body: ChangePasswordResponse = {
      accessToken: signAccess({ sub: user.id, role: user.role, name: user.name }),
      refreshToken,
      expiresIn: accessTtl,
    };
    return reply.send(body);
  });
}
