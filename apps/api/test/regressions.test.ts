/**
 * Regression tests for defects found in the M0–M2 audit. Each test fails against the
 * pre-fix code and passes after. Named by the finding they lock down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { issueRefreshToken, rotateRefreshToken } from '../src/lib/refreshTokens.js';
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

let app: FastifyInstance;
let techToken: string;
let projectId: string;
let siteId: string;
let nitrogenId: string;
let supplierId: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);

  const project = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: (await makeProjectManager('Regression PM')).id,
      site: { name: 'Reg Yard', location: 'JHB' },
    },
  });
  projectId = project.json().project.id;
  siteId = project.json().project.sites[0].id;

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  // The seed pairs both suppliers with both gases, so one id serves every line here.
  supplierId = await supplierForGas(nitrogenId);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('C1 — refresh-token rotation is genuinely single-use', () => {
  it('exactly one of N concurrent rotations of the same token succeeds', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEMO.admin } });

    // Repeat: the pre-fix read-then-write race was scheduling-dependent, so a single
    // round could pass by luck. 10 rounds x 6 racers made it near-certain to show.
    for (let round = 0; round < 10; round++) {
      const raw = await issueRefreshToken(admin.id);
      const results = await Promise.all(Array.from({ length: 6 }, () => rotateRefreshToken(raw)));
      const winners = results.filter((r) => r.ok);
      expect(winners).toHaveLength(1);
    }
  });

  it('a consumed token is rejected even when replayed immediately', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEMO.admin } });
    const raw = await issueRefreshToken(admin.id);
    expect((await rotateRefreshToken(raw)).ok).toBe(true);
    const replay = await rotateRefreshToken(raw);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('revoked');
  });
});

describe('C2 — concurrent identical clientRequestId is a replay, not a conflict', () => {
  it('both racers get the same batch (201 + 200), never a 409', async () => {
    const clientRequestId = randomUUID();
    const payload = {
      projectId,
      siteId,
      clientRequestId,
      lines: [
        {
          gasTypeId: nitrogenId,
          supplierId,
          quantity: 3,
          initialDeliveryPoint: 'STORES',
        },
      ],
    };

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/batches', headers: bearer(techToken), payload }),
      app.inject({ method: 'POST', url: '/batches', headers: bearer(techToken), payload }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 201]);
    expect(a.json().batch.id).toBe(b.json().batch.id);
    expect(a.json().serials).toEqual(b.json().serials);
    expect(await prisma.batch.count({ where: { clientRequestId } })).toBe(1);
  });
});

describe('C4 — trigram search indexes exist', () => {
  it('both GIN indexes are present (a migration must never silently drop them)', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE indexname LIKE '%trgm%' ORDER BY indexname
    `;
    expect(rows.map((r) => r.indexname)).toEqual([
      'ProjectManager_name_trgm_idx',
      'Project_projectNumber_trgm_idx',
    ]);
  });
});

describe('C5 — login does not leak account existence via timing', () => {
  it('an unknown email costs roughly as much as a wrong password', async () => {
    const time = async (email: string): Promise<number> => {
      const t0 = performance.now();
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'definitely-wrong' },
      });
      return performance.now() - t0;
    };

    await time(DEMO.admin); // warm up argon2 + the dummy hash

    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await time(DEMO.admin));
      unknown.push(await time(`ghost-${i}@nowhere.local`));
    }
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

    // Pre-fix the unknown path short-circuited argon2 entirely and was ~60x faster.
    // A generous bound keeps this robust on noisy CI while still catching that.
    expect(median(unknown)).toBeGreaterThan(median(known) / 4);
  });
});

describe('C6 — the email worker re-claims rows stranded in SENDING', () => {
  it('a row left SENDING past its lease is picked up again', async () => {
    const stranded = await prisma.outboundEmail.create({
      data: {
        to: 'stranded@pm.local',
        type: 'QR_SHEET',
        subject: 'stranded',
        bodyText: 'stranded',
        status: 'SENDING',
        attempts: 1,
        payload: { batchId: 'does-not-exist' },
      },
    });
    // Backdate past the 5-minute lease. (updatedAt is @updatedAt, so set it in SQL.)
    await prisma.$executeRaw`
      UPDATE "OutboundEmail" SET "updatedAt" = now() - interval '10 minutes' WHERE "id" = ${stranded.id}
    `;

    const processed = await processPendingEmails(10);
    expect(processed).toBeGreaterThanOrEqual(1);

    const after = await prisma.outboundEmail.findUniqueOrThrow({ where: { id: stranded.id } });
    // Re-claimed and attempted: the batch is missing so it fails, but crucially it is
    // no longer stuck — attempts advanced and it is retryable.
    expect(after.attempts).toBeGreaterThan(1);
    expect(after.status).not.toBe('SENDING');
    expect(after.lastError).toBeTruthy();
  });

  it('a fresh SENDING row is left alone (lease still held)', async () => {
    const fresh = await prisma.outboundEmail.create({
      data: {
        to: 'fresh@pm.local',
        type: 'QR_SHEET',
        subject: 'fresh',
        bodyText: 'fresh',
        status: 'SENDING',
        attempts: 1,
        payload: { batchId: 'does-not-exist' },
      },
    });
    await processPendingEmails(10);
    const after = await prisma.outboundEmail.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(after.status).toBe('SENDING');
    expect(after.attempts).toBe(1);
  });
});
