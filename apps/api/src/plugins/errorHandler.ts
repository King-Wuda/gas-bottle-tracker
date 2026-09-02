import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '../db.js';

/** Maps thrown errors to the stable `{ error: { code, message, details? } }` envelope. */
export const errorHandlerPlugin = fp(
  async (app) => {
    app.setNotFoundHandler((request, reply) => {
      reply.code(404).send({
        error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
      });
    });

    app.setErrorHandler((err: FastifyError, request, reply) => {
      if (err instanceof ZodError) {
        return reply.code(400).send({
          error: { code: 'VALIDATION', message: 'Request validation failed', details: err.issues },
        });
      }

      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') {
          return reply
            .code(409)
            .send({ error: { code: 'CONFLICT', message: 'Unique constraint violated' } });
        }
        if (err.code === 'P2025') {
          return reply
            .code(404)
            .send({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
        }
      }

      // @fastify/sensible httpErrors and anything with an explicit statusCode
      const status = err.statusCode ?? 500;
      if (status >= 500) {
        request.log.error({ err }, 'unhandled error');
        return reply
          .code(500)
          .send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
      }
      return reply.code(status).send({
        error: { code: err.code ?? 'ERROR', message: err.message },
      });
    });
  },
  { name: 'error-handler' },
);
