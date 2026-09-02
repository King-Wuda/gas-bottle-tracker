import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { Role } from '@gct/shared';
import { env } from '../env.js';

/** Access-token payload. */
export interface AccessTokenClaims {
  sub: string; // user id
  role: Role;
  name: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenClaims;
    user: AccessTokenClaims;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: 401s unless a valid access token is present; sets request.user. */
    authenticate: preHandlerHookHandler;
    /** preHandler factory: 401s if unauthenticated, 403s if the role is not allowed. */
    requireRole: (...roles: Role[]) => preHandlerHookHandler;
  }
}

export const authPlugin = fp(
  async (app) => {
    const config = env();

    await app.register(fastifyJwt, {
      secret: config.JWT_ACCESS_SECRET,
      sign: { expiresIn: config.JWT_ACCESS_TTL },
    });

    app.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.code(401).send({
          error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid access token' },
        });
      }
    });

    app.decorate('requireRole', function (...roles: Role[]): preHandlerHookHandler {
      return async function (request: FastifyRequest, reply: FastifyReply) {
        try {
          await request.jwtVerify();
        } catch {
          return reply.code(401).send({
            error: { code: 'UNAUTHENTICATED', message: 'Missing or invalid access token' },
          });
        }
        if (!roles.includes(request.user.role)) {
          return reply.code(403).send({
            error: { code: 'FORBIDDEN', message: `Requires role: ${roles.join(' | ')}` },
          });
        }
      };
    });
  },
  { name: 'auth' },
);
