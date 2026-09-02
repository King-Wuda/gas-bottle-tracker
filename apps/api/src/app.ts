import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { prisma } from './db.js';
import { env } from './env.js';
import { errorHandlerPlugin } from './plugins/errorHandler.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { batchRoutes } from './routes/batches.js';
import { initializationRoutes } from './routes/initializations.js';
import { transferRoutes } from './routes/transfers.js';
import { returnRoutes } from './routes/returns.js';
import { historyRoutes } from './routes/history.js';
import { adminRoutes } from './routes/admin.js';

/**
 * Builds the Fastify instance without listening. Tests import this and call
 * `app.listen({ port: 0 })`; `server.ts` adds signal handling and a real port.
 */
export async function buildApp(): Promise<FastifyInstance> {
  env(); // fail fast on bad configuration

  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // Fastify's default is 1 MiB, which is smaller than the things this API is
    // deliberately designed to accept: a batch photo (bounded at PHOTO_MAX_BASE64 =
    // 4 MB of base64) plus a driver's signature plus 500 scans in one return. Left at
    // the default, a perfectly valid field submission would have failed with a bare
    // 413 that no schema message explains — and it would have failed only for the
    // heaviest, least reproducible requests.
    bodyLimit: 12 * 1024 * 1024,
  });

  await app.register(sensible);
  // The native app doesn't need CORS, but the Expo *web* build (and any future admin
  // UI) is a browser origin calling this API cross-origin. CORS_ORIGINS is a comma-
  // separated allowlist; unset means reflect the request origin, which is fine for
  // local dev but should be set explicitly in production.
  const origins = process.env.CORS_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: origins && origins.length > 0 ? origins : true,
    credentials: true,
  });
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  app.get('/health', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'up' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'degraded', db: 'down' });
    }
  });

  await app.register(authRoutes);
  await app.register(projectRoutes);
  await app.register(batchRoutes);
  await app.register(initializationRoutes);
  await app.register(transferRoutes);
  await app.register(returnRoutes);
  await app.register(historyRoutes);
  await app.register(adminRoutes);

  // Optional: serve the Expo web export from this same origin under /app.
  // Off by default (tests and production API deployments don't want it). Enabling it
  // gives a single public URL for demos and sidesteps CORS entirely, since the UI and
  // the API then share an origin.
  const webRoot = process.env.SERVE_WEB_APP;
  if (webRoot && existsSync(webRoot)) {
    const root = path.resolve(webRoot);
    await app.register(fastifyStatic, { root, prefix: '/app/', wildcard: false });
    // SPA fallback: expo-router does client-side routing, so any unmatched /app/* path
    // must return index.html rather than 404.
    app.get('/app', (_req, reply) => reply.sendFile('index.html', root));
    app.get('/app/*', (_req, reply) => reply.sendFile('index.html', root));
    // Convenience: the forwarded Codespace URL has no path, so a bare origin would 404
    // and read as "the server is down". Send it to the app instead.
    app.get('/', (_req, reply) => reply.redirect('/app', 302));
    app.log.info({ root }, 'serving web app at /app');
  }

  return app;
}
