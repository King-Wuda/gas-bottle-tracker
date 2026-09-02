import type { FastifyInstance } from 'fastify';
import {
  loginRequestSchema,
  refreshRequestSchema,
  logoutRequestSchema,
  type LoginResponse,
  type RefreshResponse,
  type MeResponse,
  type UserDto,
} from '@gct/shared';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { dummyHash, verifyPassword } from '../lib/password.js';
import { issueRefreshToken, rotateRefreshToken, revokeRefreshToken } from '../lib/refreshTokens.js';
import type { AccessTokenClaims } from '../plugins/auth.js';

const toUserDto = (u: {
  id: string;
  email: string;
  name: string;
  role: UserDto['role'];
  active: boolean;
}): UserDto => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const signAccess = (claims: AccessTokenClaims): string => app.jwt.sign(claims);
  const accessTtl = env().JWT_ACCESS_TTL;

  app.post('/auth/login', async (request, reply) => {
    const { email, password } = loginRequestSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { email } });
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
}
