import { buildApp } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';
import { startEmailWorker, stopEmailWorker } from './services/emailWorker.js';
import { stopIdOcr } from './services/idOcr.js';

const config = env();

const app = await buildApp();

startEmailWorker(app.log);

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  stopEmailWorker();
  // The OCR worker owns a child process; leaving it running holds the exit open.
  await stopIdOcr();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
