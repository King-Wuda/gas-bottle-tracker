import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { loadEnv } from '../src/env.js';
import { setMailer, type MailMessage } from '../src/services/mailer/index.js';
import { processPendingEmails } from '../src/services/emailWorker.js';
import {
  loginAs,
  bearer,
  DEMO,
  makeProjectManager,
  resetDb,
  supplierForGas,
  uniqueProjectNumber,
} from './helpers.js';

/**
 * M5 — the branches M0–M4 shipped but never executed under test: the email worker's
 * failure/retry path, its concurrent claim, `/health`'s degraded branch, and env
 * validation. Each of these is code that only runs when something has already gone
 * wrong, which is exactly when you cannot afford it to be wrong itself.
 */

let app: FastifyInstance;
let techToken: string;
let projectId: string;
let siteId: string;
let nitrogenId: string;
let supplierId: string;

beforeAll(async () => {
  await resetDb(); // exact drain counts, so no other suite's emails may be pending
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);

  const project = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: (await makeProjectManager('Hardening PM')).id,
      site: { name: 'Hardening Yard', location: 'JHB' },
    },
  });
  projectId = project.json().project.id;
  siteId = project.json().project.sites[0].id;

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  // The seed pairs both suppliers with both gases, so one id serves every line here.
  supplierId = await supplierForGas(nitrogenId);
});

afterEach(() => {
  setMailer(undefined); // back to the capture transport
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Creates a batch, which queues exactly one QR_SHEET email. Returns that email's id. */
async function queueOneEmail(quantity = 2): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: {
      projectId,
      siteId,
      clientRequestId: randomUUID(),
      lines: [
        {
          gasTypeId: nitrogenId,
          supplierId,
          quantity,
          initialDeliveryPoint: 'STORES',
        },
      ],
    },
  });
  if (res.statusCode !== 201) throw new Error(`batch failed: ${res.statusCode} ${res.body}`);
  const row = await prisma.outboundEmail.findFirstOrThrow({
    where: { payload: { path: ['batchId'], equals: res.json().batch.id } },
  });
  return row.id;
}

const emailRow = (id: string) => prisma.outboundEmail.findUniqueOrThrow({ where: { id } });

describe('email worker — send failures', () => {
  it('retries a failing send, then gives up at the attempt cap', async () => {
    const id = await queueOneEmail();
    let calls = 0;
    setMailer({
      send: () => {
        calls++;
        return Promise.reject(new Error('SMTP connection refused'));
      },
    });

    // MAX_ATTEMPTS is 5, so the first four failures re-arm the row and the fifth
    // retires it. Draining a sixth time must be a no-op, not a sixth send.
    for (let i = 1; i <= 4; i++) {
      expect(await processPendingEmails(10)).toBe(1);
      const row = await emailRow(id);
      expect(row.status).toBe('PENDING'); // still retryable
      expect(row.attempts).toBe(i);
      expect(row.lastError).toContain('SMTP connection refused');
    }

    expect(await processPendingEmails(10)).toBe(1);
    const dead = await emailRow(id);
    expect(dead.status).toBe('FAILED');
    expect(dead.attempts).toBe(5);
    expect(dead.sentAt).toBeNull();

    // The cap is real: a FAILED row is not re-claimed.
    expect(await processPendingEmails(10)).toBe(0);
    expect(calls).toBe(5);
  });

  it('recovers when the mail server comes back mid-retry', async () => {
    const id = await queueOneEmail();
    setMailer({ send: () => Promise.reject(new Error('temporary outage')) });
    await processPendingEmails(10);
    expect((await emailRow(id)).status).toBe('PENDING');

    const sent: MailMessage[] = [];
    setMailer({
      send: (msg) => {
        sent.push(msg);
        return Promise.resolve();
      },
    });
    await processPendingEmails(10);

    const row = await emailRow(id);
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    // A successful send must clear the stale error, or the row reads as a failure forever.
    expect(row.lastError).toBeNull();
    expect(row.attachmentPaths.length).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.attachments?.[0]!.contentType).toBe('application/pdf');
  });

  it('retires a permanently unbuildable email instead of retrying forever', async () => {
    // A QR_SHEET whose payload lost its batchId can never succeed; it must still walk
    // the attempt cap rather than blocking the queue.
    const row = await prisma.outboundEmail.create({
      data: {
        to: 'nobody@pm.local',
        type: 'QR_SHEET',
        subject: 'broken',
        bodyText: 'broken',
        payload: {},
        attempts: 4, // one short of the cap
      },
    });
    await processPendingEmails(10);
    const after = await emailRow(row.id);
    expect(after.status).toBe('FAILED');
    expect(after.lastError).toContain('batchId');
  });
});

describe('email worker — concurrent claim', () => {
  it('never sends the same email twice when workers overlap', async () => {
    const ids = await Promise.all([queueOneEmail(), queueOneEmail(), queueOneEmail()]);

    const sentSubjects: string[] = [];
    setMailer({
      send: async (msg) => {
        // Hold the row in SENDING long enough that the other workers are certainly
        // inside their own claim while this one is unfinished.
        await new Promise((r) => setTimeout(r, 60));
        sentSubjects.push(msg.subject);
      },
    });

    // Six concurrent drains over three rows. Without FOR UPDATE SKIP LOCKED the
    // claims would overlap and the PM would get duplicate QR sheets.
    const claimed = await Promise.all(Array.from({ length: 6 }, () => processPendingEmails(10)));

    expect(claimed.reduce((a, b) => a + b, 0)).toBe(3); // each row claimed exactly once
    expect(sentSubjects).toHaveLength(3);
    expect(new Set(sentSubjects).size).toBe(3);

    const rows = await prisma.outboundEmail.findMany({ where: { id: { in: ids } } });
    expect(rows.every((r) => r.status === 'SENT' && r.attempts === 1)).toBe(true);
  });

  it('re-claims a row stranded in SENDING by a crashed worker', async () => {
    const id = await queueOneEmail();
    // Simulate the crash: claimed, lease long expired, never settled.
    await prisma.outboundEmail.update({
      where: { id },
      data: { status: 'SENDING', attempts: 1, updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

    setMailer({ send: () => Promise.resolve() });
    expect(await processPendingEmails(10)).toBe(1);
    expect((await emailRow(id)).status).toBe('SENT');
  });

  it('leaves a freshly-claimed row alone until its lease expires', async () => {
    const id = await queueOneEmail();
    await prisma.outboundEmail.update({
      where: { id },
      data: { status: 'SENDING', attempts: 1, updatedAt: new Date() },
    });

    setMailer({ send: () => Promise.resolve() });
    expect(await processPendingEmails(10)).toBe(0);
    expect((await emailRow(id)).status).toBe('SENDING');
  });
});

describe('GET /health', () => {
  it('reports ok while the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'up' });
  });

  it('needs no authentication — a load balancer has no token', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('reports 503 degraded when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'down' });
  });
});

describe('env validation', () => {
  // MAILER defaults to `resend`, which requires a key — so the minimum viable
  // environment carries one. That is the point: there is no configuration of this
  // server that boots believing it can send mail and cannot.
  const base = {
    DATABASE_URL: 'postgresql://gct:gct@localhost:5432/gct',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    RESEND_API_KEY: 're_test_key',
  };

  it('applies defaults for everything optional', () => {
    const env = loadEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.SERIAL_YEAR_TZ).toBe('Africa/Johannesburg');
  });

  it('defaults to the transport that actually sends mail', () => {
    // Not to a sink. A default that silently delivers nothing is the worst state
    // available: batches save, the queue drains, and nobody notices the project
    // manager stopped receiving QR sheets. This is what MAILER=mailhog used to be.
    expect(loadEnv({ ...base }).MAILER).toBe('resend');
  });

  /** `base` minus the mail key, for the cases that are about its absence. */
  const withoutMailKey = (): Record<string, string> => {
    const copy: Record<string, string> = { ...base };
    delete copy.RESEND_API_KEY;
    return copy;
  };

  it('refuses to boot with no mail credentials at all', () => {
    expect(() => loadEnv(withoutMailKey())).toThrow(/RESEND_API_KEY/);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadEnv({ JWT_ACCESS_SECRET: 'x'.repeat(32) })).toThrow(/DATABASE_URL/);
  });

  it('rejects a weak access secret rather than booting with it', () => {
    expect(() => loadEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects a time zone the serial allocator could not use', () => {
    // A bad TZ would silently shift the [YY] segment — or throw deep inside allocation.
    expect(() => loadEnv({ ...base, SERIAL_YEAR_TZ: 'Mars/Olympus' })).toThrow(/time zone/);
  });

  it('accepts a real IANA zone', () => {
    expect(loadEnv({ ...base, SERIAL_YEAR_TZ: 'Europe/London' }).SERIAL_YEAR_TZ).toBe(
      'Europe/London',
    );
  });

  it('rejects a malformed QR signing key', () => {
    expect(() => loadEnv({ ...base, QR_SIGN_PRIVATE_KEY_HEX: 'not-hex' })).toThrow();
  });

  it('coerces numeric strings, since process.env only holds strings', () => {
    const env = loadEnv({ ...base, PORT: '8080', JWT_ACCESS_TTL: '2525' });
    expect(env.PORT).toBe(8080);
    expect(env.JWT_ACCESS_TTL).toBe(2525);
  });

  it('rejects an unknown mailer instead of falling back to one', () => {
    expect(() => loadEnv({ ...base, MAILER: 'postmark' })).toThrow();
  });

  it('refuses to boot with a production mailer and no credentials', () => {
    // Caught here rather than at the first send. A server that starts happily and only
    // reveals the missing key when a technician's batch fails to reach its project
    // manager has moved the error to where nobody is watching.
    const noKey = withoutMailKey();
    expect(() => loadEnv({ ...noKey, MAILER: 'resend' })).toThrow(/RESEND_API_KEY/);
    expect(() => loadEnv({ ...noKey, MAILER: 'sendgrid' })).toThrow(/SENDGRID_API_KEY/);

    expect(loadEnv({ ...base, MAILER: 'resend', RESEND_API_KEY: 're_x' }).MAILER).toBe('resend');
    // `capture` needs no credentials — it is the test transport and sends nothing.
    expect(loadEnv({ ...withoutMailKey(), MAILER: 'capture' }).MAILER).toBe('capture');
  });

  it('lets EMAIL_FROM stand in for MAIL_FROM without breaking the old name', () => {
    expect(loadEnv({ ...base }).EMAIL_FROM).toBeUndefined();
    expect(loadEnv({ ...base, EMAIL_FROM: 'A <a@b.c>' }).EMAIL_FROM).toBe('A <a@b.c>');
    expect(loadEnv({ ...base }).MAIL_FROM).toContain('@');
  });
});

describe('GET /batches — query validation', () => {
  it('defaults to active batches', async () => {
    const res = await app.inject({ method: 'GET', url: '/batches', headers: bearer(techToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().batches.every((b: { status: string }) => b.status !== 'RETURNED')).toBe(true);
  });

  it('accepts status=all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/batches?status=all',
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unrecognised status rather than silently answering "active"', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/batches?status=RETRUNED',
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects an empty projectId, which would otherwise match nothing silently', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/batches?projectId=',
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(400);
  });
});
