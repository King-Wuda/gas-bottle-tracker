import { setDefaultResultOrder } from 'node:dns';
import { buildApp } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';
import { startEmailWorker, stopEmailWorker } from './services/emailWorker.js';
import { stopIdOcr } from './services/idOcr.js';

/**
 * Prefer IPv4 addresses when resolving a hostname.
 *
 * Container platforms routinely give a workload IPv4 egress and NO IPv6 route, while
 * DNS still answers with an AAAA record — `smtp.gmail.com` publishes both. Node's
 * default since v17 is to use whatever order DNS returned, so it dials the IPv6
 * address and the connection dies with `ENETUNREACH`. That is not a credentials
 * problem and not a firewall problem, and it reads like neither: the send simply
 * hangs and retries forever. It is exactly how the first SMTP deploy failed here.
 *
 * A preference, not a restriction — `ipv4first` still falls back to IPv6 if there is
 * no IPv4 address — so a genuinely IPv6-only host keeps working.
 *
 * Set here rather than in the mailer because it is a property of the machine, not of
 * SMTP: every outbound connection this process makes is better off with it.
 */
setDefaultResultOrder('ipv4first');

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
