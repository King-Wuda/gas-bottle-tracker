import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ScanInput, ScanRejection } from '@gct/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { qrPayloadFor } from '../src/services/qr.js';
import { readFileAt } from '../src/services/storage.js';
import {
  loginAs,
  bearer,
  DEMO,
  initializeBatch,
  makeProjectManager,
  resetDb,
  supplierForGas,
  testDriverId,
  testSignOff,
  testPhoto,
  uniqueProjectNumber,
} from './helpers.js';

let app: FastifyInstance;
let techToken: string;
let storesToken: string;
let adminToken: string;
let projectId: string;
let siteA: string;
let siteB: string;
let nitrogenId: string;
let supplierId: string;
let pmEmail: string;

/** A 1×1 transparent PNG — real PNG magic bytes, which the route insists on. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SIGNATURE = `data:image/png;base64,${PNG_1X1}`;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);
  adminToken = await loginAs(app, DEMO.admin);

  const pm = await makeProjectManager('Return PM');
  pmEmail = pm.email;
  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: pm.id,
      site: { name: 'Yard A', location: 'JHB' },
    },
  });
  projectId = created.json().project.id;
  siteA = created.json().project.sites[0].id;

  siteB = (
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/sites`,
      headers: bearer(techToken),
      payload: { name: 'Yard B', location: 'PTA' },
    })
  ).json().site.id;

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  // The seed pairs both suppliers with both gases, so one id serves every line here.
  supplierId = await supplierForGas(nitrogenId);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function makeBatch(quantity: number): Promise<{ batchId: string; serials: string[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: {
      projectId,
      siteId: siteA,
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
  if (res.statusCode !== 201) throw new Error(`makeBatch failed: ${res.statusCode} ${res.body}`);
  const batchId = res.json().batch.id as string;
  const serials = res.json().serials as string[];

  // Scan the batch in so it is legal to move. Transfers and returns refuse an
  // uninitialized batch (409), which is the point of the step — but it is not what
  // any test below is about, so it happens here once.
  await initializeBatch(app, techToken, batchId, serials);
  return { batchId, serials };
}

const scan = (serialCode: string): ScanInput => ({
  serialCode,
  qrPayload: qrPayloadFor(serialCode),
  scannedAt: new Date().toISOString(),
});

const postReturn = (payload: Record<string, unknown>, token = storesToken) =>
  app.inject({
    method: 'POST',
    url: '/returns',
    headers: bearer(token),
    payload: { photo: testPhoto(), ...payload },
  });

const returnBody = (batchId: string, serials: string[], extra: Record<string, unknown> = {}) => ({
  batchId,
  clientRequestId: randomUUID(),
  scans: serials.map(scan),
  driverName: 'Sipho Ndlovu',
  ...testDriverId(),
  signaturePng: SIGNATURE,
  ...extra,
});

/** Deploys cylinders to a site first, so a return has a real origin to record. */
const deployToB = (batchId: string, serials: string[]) =>
  app.inject({
    method: 'POST',
    url: '/transfers',
    headers: bearer(techToken),
    payload: {
      ...testSignOff(),
      photo: testPhoto(),
      batchId,
      clientRequestId: randomUUID(),
      destination: { type: 'SITE', siteId: siteB },
      scans: serials.map(scan),
    },
  });

const rejectionFor = (rejected: ScanRejection[], serialCode: string) =>
  rejected.find((r) => r.serialCode === serialCode);

describe('POST /returns — happy paths', () => {
  it('marks scanned cylinders RETURNED, records RETURN events, queues the PM note', async () => {
    const { batchId, serials } = await makeBatch(3);
    await deployToB(batchId, serials);

    const res = await postReturn(returnBody(batchId, serials));

    expect(res.statusCode).toBe(201);
    const { returnRecord, rejected } = res.json();
    expect(rejected).toEqual([]);
    expect(returnRecord.returnedSerials).toEqual([...serials].sort());
    expect(returnRecord.driverName).toBe('Sipho Ndlovu');
    expect(returnRecord.batchStatus).toBe('RETURNED');
    expect(returnRecord.outstandingCount).toBe(0);

    const rows = await prisma.cylinder.findMany({ where: { serialCode: { in: serials } } });
    expect(rows.every((c) => c.status === 'RETURNED' && c.currentSiteId === null)).toBe(true);

    const events = await prisma.movementEvent.findMany({
      where: { returnRecordId: returnRecord.id },
    });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === 'RETURN' && e.toSiteId === null)).toBe(true);
    // The origin is where the cylinders actually were — Yard B, not stores.
    expect(events.every((e) => e.fromSiteId === siteB)).toBe(true);

    const email = await prisma.outboundEmail.findFirst({
      where: {
        type: 'DELIVERY_NOTE',
        payload: { path: ['returnRecordId'], equals: returnRecord.id },
      },
    });
    expect(email?.status).toBe('PENDING');
    expect(email?.to).toBe(pmEmail);

    const record = await prisma.returnRecord.findUniqueOrThrow({ where: { id: returnRecord.id } });
    expect(record.signaturePath).toMatch(/^signatures\/signature-.*\.png$/);
  });

  it('returns cylinders straight from stores (fromSiteId NULL)', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn(returnBody(batchId, serials));

    expect(res.statusCode).toBe(201);
    const event = await prisma.movementEvent.findFirstOrThrow({
      where: { returnRecordId: res.json().returnRecord.id },
    });
    expect(event.fromSiteId).toBeNull();
  });

  it('allows an admin to process a return', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn(returnBody(batchId, serials), adminToken);
    expect(res.statusCode).toBe(201);
  });

  it('records deviceAt from the scan, so an offline return keeps its real timestamp', async () => {
    const { batchId, serials } = await makeBatch(1);
    const scannedAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const res = await postReturn({
      ...returnBody(batchId, []),
      scans: [{ ...scan(serials[0]!), scannedAt: scannedAt.toISOString() }],
    });

    expect(res.statusCode).toBe(201);
    const event = await prisma.movementEvent.findFirstOrThrow({
      where: { returnRecordId: res.json().returnRecord.id },
    });
    expect(event.deviceAt.toISOString()).toBe(scannedAt.toISOString());
  });
});

describe('POST /returns — partial returns (the spec’s real-world case)', () => {
  it('3 of 5 → PARTIAL, then the remaining 2 → RETURNED', async () => {
    const { batchId, serials } = await makeBatch(5);

    const first = await postReturn(returnBody(batchId, serials.slice(0, 3)));
    expect(first.statusCode).toBe(201);
    expect(first.json().returnRecord.batchStatus).toBe('PARTIAL');
    expect(first.json().returnRecord.outstandingCount).toBe(2);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe(
      'PARTIAL',
    );

    const second = await postReturn(returnBody(batchId, serials.slice(3)));
    expect(second.statusCode).toBe(201);
    expect(second.json().returnRecord.batchStatus).toBe('RETURNED');
    expect(second.json().returnRecord.outstandingCount).toBe(0);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe(
      'RETURNED',
    );

    // Two separate collection visits, each with its own signed note.
    expect(await prisma.returnRecord.count({ where: { batchId } })).toBe(2);
    expect(await prisma.outboundEmail.count({ where: { type: 'DELIVERY_NOTE' } })).toBeGreaterThan(
      1,
    );
  });

  it('a fully-returned batch drops out of the active batch list', async () => {
    const { batchId, serials } = await makeBatch(2);
    await postReturn(returnBody(batchId, serials));

    const list = await app.inject({
      method: 'GET',
      url: `/batches?projectId=${projectId}`,
      headers: bearer(storesToken),
    });
    expect(list.json().batches.map((b: { id: string }) => b.id)).not.toContain(batchId);
  });
});

describe('POST /returns — idempotency', () => {
  it('replaying the same clientRequestId returns the original record, not a second one', async () => {
    const { batchId, serials } = await makeBatch(2);
    const payload = returnBody(batchId, serials);

    const first = await postReturn(payload);
    expect(first.statusCode).toBe(201);

    const replay = await postReturn(payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().returnRecord.id).toBe(first.json().returnRecord.id);
    expect(replay.json().returnRecord.returnedSerials).toEqual([...serials].sort());

    expect(await prisma.returnRecord.count({ where: { batchId } })).toBe(1);
    // Exactly one delivery note — the PM is not emailed twice for one collection.
    expect(
      await prisma.outboundEmail.count({
        where: { payload: { path: ['returnRecordId'], equals: first.json().returnRecord.id } },
      }),
    ).toBe(1);
  });

  it('concurrent replays of one queued return produce exactly one record', async () => {
    // Race probe — see the transfers suite for why this runs several rounds.
    for (let round = 0; round < 6; round++) {
      const { batchId, serials } = await makeBatch(3);
      const payload = returnBody(batchId, serials);

      const results = await Promise.all(Array.from({ length: 6 }, () => postReturn(payload)));

      expect(results.map((r) => r.statusCode).filter((s) => s !== 200 && s !== 201)).toEqual([]);
      expect(new Set(results.map((r) => r.json().returnRecord.id)).size).toBe(1);
      expect(await prisma.returnRecord.count({ where: { batchId } })).toBe(1);
      expect(
        await prisma.movementEvent.count({ where: { cylinder: { batchId }, type: 'RETURN' } }),
      ).toBe(3);
    }
  });
});

describe('POST /returns — per-serial scan validation', () => {
  it('rejects an unknown serial but still returns the valid ones', async () => {
    const { batchId, serials } = await makeBatch(2);
    const res = await postReturn({
      ...returnBody(batchId, serials),
      scans: [...serials.map(scan), scan('NIT99-997')],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().returnRecord.returnedSerials).toEqual([...serials].sort());
    expect(rejectionFor(res.json().rejected, 'NIT99-997')?.code).toBe('UNKNOWN_SERIAL');
  });

  it('rejects a serial from another batch and leaves it untouched', async () => {
    const mine = await makeBatch(1);
    const theirs = await makeBatch(1);

    const res = await postReturn({
      ...returnBody(mine.batchId, []),
      scans: [scan(mine.serials[0]!), scan(theirs.serials[0]!)],
    });

    expect(res.statusCode).toBe(201);
    expect(rejectionFor(res.json().rejected, theirs.serials[0]!)?.code).toBe('WRONG_BATCH');
    const stranger = await prisma.cylinder.findUniqueOrThrow({
      where: { serialCode: theirs.serials[0]! },
    });
    expect(stranger.status).toBe('IN_STORES');
  });

  it('rejects an already-returned cylinder — returning twice is not a second return', async () => {
    const { batchId, serials } = await makeBatch(2);
    await postReturn(returnBody(batchId, [serials[0]!]));

    const res = await postReturn(returnBody(batchId, serials));
    expect(res.statusCode).toBe(201);
    expect(res.json().returnRecord.returnedSerials).toEqual([serials[1]]);
    expect(rejectionFor(res.json().rejected, serials[0]!)?.code).toBe('ALREADY_RETURNED');
  });

  it('rejects a forged QR — a return must be proven by a real label', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({
      ...returnBody(batchId, []),
      scans: [
        {
          ...scan(serials[0]!),
          qrPayload: `GCT2|${serials[0]}|${'cd'.repeat(64)}`,
        },
      ],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rejected[0].code).toBe('BAD_QR_SIGNATURE');
    const cyl = await prisma.cylinder.findUniqueOrThrow({ where: { serialCode: serials[0]! } });
    expect(cyl.status).toBe('IN_STORES');
  });

  it('creates no ReturnRecord and queues no email when every scan is rejected', async () => {
    const { batchId } = await makeBatch(1);
    const emailsBefore = await prisma.outboundEmail.count();

    const res = await postReturn({ ...returnBody(batchId, []), scans: [scan('NIT99-996')] });

    expect(res.statusCode).toBe(422);
    expect(await prisma.returnRecord.count({ where: { batchId } })).toBe(0);
    expect(await prisma.outboundEmail.count()).toBe(emailsBefore);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe(
      'ACTIVE',
    );
  });
});

describe('POST /returns — request validation', () => {
  it('refuses a return with no scans', async () => {
    const { batchId } = await makeBatch(1);
    const res = await postReturn({ ...returnBody(batchId, []), scans: [] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('refuses a signature that is not actually a PNG', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({
      ...returnBody(batchId, serials),
      signaturePng: `data:image/png;base64,${Buffer.from('x'.repeat(100)).toString('base64')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
  });

  it('refuses a missing driver name — the note needs someone to have signed', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({ ...returnBody(batchId, serials), driverName: '' });
    expect(res.statusCode).toBe(400);
  });

  it('403s a technician — returns are the stores manager’s job', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn(returnBody(batchId, serials), techToken);
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown batch', async () => {
    const res = await postReturn(returnBody('nope', ['NIT26-001']));
    expect(res.statusCode).toBe(404);
  });
});

/**
 * The driver's identity (Workflow C4).
 *
 * A signature is a squiggle over a name somebody typed. The number and the
 * photographed document are what make "who took the cylinders" checkable afterwards,
 * so they follow exactly the rules the batch photo already follows: mandatory,
 * waivable only by an admin, and the waiver recorded as a waiver.
 */
describe('POST /returns — driver identity', () => {
  it('records the ID number and stores the photographed document', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn(returnBody(batchId, serials));

    expect(res.statusCode).toBe(201);
    const { returnRecord } = res.json();
    expect(returnRecord.driverIdNumber).toBe('8801015009087');
    expect(returnRecord.driverIdCaptured).toBe(true);
    expect(returnRecord.driverIdOverridden).toBe(false);

    const row = await prisma.returnRecord.findUniqueOrThrow({ where: { id: returnRecord.id } });
    expect(row.driverIdNumber).toBe('8801015009087');
    // Named from the idempotency key, like every other blob, so a retry overwrites
    // its own file instead of littering one per attempt.
    expect(row.driverIdPath).toContain(`driver-id-${row.clientRequestId}`);
    await expect(readFileAt(row.driverIdPath!)).resolves.toBeInstanceOf(Buffer);
  });

  it('refuses a return with no ID number', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({ ...returnBody(batchId, serials), driverIdNumber: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('accepts a passport or foreign licence number, not only a South African ID', async () => {
    // A driver who cannot be recorded is a driver who leaves with the cylinders and
    // no name against them, which is worse than a number in an unexpected format.
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({
      ...returnBody(batchId, serials),
      driverIdNumber: 'ZW-DL-88231/04',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().returnRecord.driverIdNumber).toBe('ZW-DL-88231/04');
  });

  it('refuses a return with neither an ID photo nor an override', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({ ...returnBody(batchId, serials), driverIdPhoto: null });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('refuses a non-admin who claims the ID override, rather than ignoring it', async () => {
    // Silently dropping it would let a tampered client believe it recorded a return
    // that a stores manager is not entitled to record.
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({
      ...returnBody(batchId, serials),
      driverIdPhoto: null,
      driverIdOverride: true,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DRIVER_ID_OVERRIDE_FORBIDDEN');
  });

  it('lets an admin waive the ID photo, and records it as a waiver', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn(
      { ...returnBody(batchId, serials), driverIdPhoto: null, driverIdOverride: true },
      adminToken,
    );
    expect(res.statusCode).toBe(201);
    const { returnRecord } = res.json();
    expect(returnRecord.driverIdOverridden).toBe(true);
    expect(returnRecord.driverIdCaptured).toBe(false);
    // The number is still required — the waiver is of the camera, not of identity.
    expect(returnRecord.driverIdNumber).toBe('8801015009087');

    const row = await prisma.returnRecord.findUniqueOrThrow({ where: { id: returnRecord.id } });
    expect(row.driverIdPath).toBeNull();
  });

  it('keeps the photo when a submission carries both a photo and an override', async () => {
    // Real evidence outranks an assertion, exactly as a genuinely scanned serial
    // keeps its scan even when it also appears in overrideSerials.
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn(
      { ...returnBody(batchId, serials), driverIdOverride: true },
      adminToken,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().returnRecord.driverIdCaptured).toBe(true);
    expect(res.json().returnRecord.driverIdOverridden).toBe(false);
  });

  it('refuses an ID payload that is not actually an image', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postReturn({
      ...returnBody(batchId, serials),
      driverIdPhoto: testPhoto({
        imageBase64: `data:image/jpeg;base64,${Buffer.from('x'.repeat(100)).toString('base64')}`,
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_DRIVER_ID_PHOTO');
  });

  it('reports the ID number on the history event detail', async () => {
    const { batchId, serials } = await makeBatch(1);
    const created = await postReturn(returnBody(batchId, serials));
    expect(created.statusCode).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/history/events/RETURN/${created.json().returnRecord.id}`,
      headers: bearer(storesToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().event.driverIdNumber).toBe('8801015009087');
  });
});

describe('POST /returns — concurrency', () => {
  it('two returns splitting one batch both commit, and the batch still reaches RETURNED', async () => {
    // Two things are guarded here, and both are lock-related.
    //
    // 1. The batch status is a function of ALL its cylinders. Without serialising on
    //    the batch row, each request counts within its own snapshot, both conclude
    //    "some still out", and the batch is stuck at PARTIAL forever — with every
    //    cylinder returned, still accruing rental.
    // 2. Taking that lock AFTER inserting the ReturnRecord deadlocks (40P01): the
    //    record's FK already holds FOR KEY SHARE on this batch row, so both
    //    transactions sit waiting to upgrade. That needs the two inserts to
    //    interleave, so this runs several rounds rather than one.
    for (let round = 0; round < 8; round++) {
      const { batchId, serials } = await makeBatch(4);

      const [a, b] = await Promise.all([
        postReturn(returnBody(batchId, serials.slice(0, 2))),
        postReturn(returnBody(batchId, serials.slice(2))),
      ]);

      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
      expect(batch.status).toBe('RETURNED');
      expect(await prisma.cylinder.count({ where: { batchId, status: { not: 'RETURNED' } } })).toBe(
        0,
      );
    }
  });

  it('two returns racing for the SAME cylinder: it is returned once, the loser sees CONFLICT', async () => {
    const { batchId, serials } = await makeBatch(1);
    const payloadA = returnBody(batchId, serials);
    const payloadB = returnBody(batchId, serials); // different clientRequestId

    const [a, b] = await Promise.all([postReturn(payloadA), postReturn(payloadB)]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
    const loser = a.statusCode === 422 ? a : b;
    expect(['CONFLICT', 'ALREADY_RETURNED']).toContain(loser.json().error.details.rejected[0].code);

    const events = await prisma.movementEvent.findMany({
      where: { cylinder: { batchId }, type: 'RETURN' },
    });
    expect(events).toHaveLength(1);
  });
});
