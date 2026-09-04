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
/** A site in a DIFFERENT project — a destination that must be refused. */
let foreignSiteId: string;
let nitrogenId: string;
let supplierId: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);
  adminToken = await loginAs(app, DEMO.admin);

  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: (await makeProjectManager('Transfer PM')).id,
      site: { name: 'Yard A', location: 'JHB' },
    },
  });
  projectId = created.json().project.id;
  siteA = created.json().project.sites[0].id;

  const second = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/sites`,
    headers: bearer(techToken),
    payload: { name: 'Yard B', location: 'PTA' },
  });
  siteB = second.json().site.id;

  const other = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: (await makeProjectManager('Other PM')).id,
      site: { name: 'Foreign Yard', location: 'CPT' },
    },
  });
  foreignSiteId = other.json().project.sites[0].id;

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  // The seed pairs both suppliers with both gases, so one id serves every line here.
  supplierId = await supplierForGas(nitrogenId);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Creates a batch and returns its id + allocated serials. */
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

/** A 1x1 PNG — `services/signature.ts` checks the magic bytes, not the drawing. */
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A genuine scan: the payload is signed exactly as the printed label is. */
const scan = (serialCode: string): ScanInput => ({
  serialCode,
  qrPayload: qrPayloadFor(serialCode),
  scannedAt: new Date().toISOString(),
});

/**
 * Every transfer carries a batch photo AND the driver sign-off — the name, the ID
 * number, a photo of the document and a signature. A test that is about one of those
 * overrides it; every other test would otherwise be a 400 about something it is not
 * testing.
 */
const postTransfer = (payload: Record<string, unknown>, token = techToken) =>
  app.inject({
    method: 'POST',
    url: '/transfers',
    headers: bearer(token),
    payload: {
      photo: testPhoto(),
      driverName: 'Sipho Ndlovu',
      signaturePng: SIGNATURE,
      ...testDriverId(),
      ...payload,
    },
  });

const toSite = (siteId: string) => ({ type: 'SITE' as const, siteId });
const toStores = { type: 'STORES' as const };

const rejectionFor = (rejected: ScanRejection[], serialCode: string) =>
  rejected.find((r) => r.serialCode === serialCode);

/**
 * The driver sign-off (Workflow B5).
 *
 * A transfer hands physical cylinders to someone who drives away with them, exactly
 * as a return does. These are the same rules `returns.test.ts` asserts, applied to the
 * more common movement — which is the one that used to record nobody.
 */
describe('POST /transfers — driver sign-off', () => {
  it('records the driver, the ID number and the document', async () => {
    const { batchId, serials } = await makeBatch(2);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: serials.map(scan),
    });

    expect(res.statusCode).toBe(201);
    const { transfer } = res.json();
    expect(transfer.driverName).toBe('Sipho Ndlovu');
    expect(transfer.driverIdNumber).toBe('8801015009087');
    expect(transfer.driverIdCaptured).toBe(true);
    expect(transfer.driverIdOverridden).toBe(false);

    const row = await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
    // Named from the idempotency key, like every other blob, so a retry overwrites
    // its own file rather than littering one per attempt.
    expect(row.signaturePath).toContain(`signature-${row.clientRequestId}`);
    expect(row.driverIdPath).toContain(`driver-id-${row.clientRequestId}`);
    await expect(readFileAt(row.signaturePath!)).resolves.toBeInstanceOf(Buffer);
  });

  it('refuses a transfer with no driver name, ID number or signature', async () => {
    const { batchId, serials } = await makeBatch(1);
    for (const missing of [
      { driverName: '' },
      { driverIdNumber: '' },
      { signaturePng: '' },
      { driverIdPhoto: null },
    ]) {
      const res = await postTransfer({
        batchId,
        clientRequestId: randomUUID(),
        destination: toSite(siteB),
        scans: serials.map(scan),
        ...missing,
      });
      expect(res.statusCode, JSON.stringify(missing)).toBe(400);
    }
  });

  it('refuses a signature that is not actually a PNG', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: serials.map(scan),
      signaturePng: `data:image/png;base64,${Buffer.from('x'.repeat(100)).toString('base64')}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SIGNATURE');
  });

  it('refuses a non-admin who claims the ID override, rather than ignoring it', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: serials.map(scan),
      driverIdPhoto: null,
      driverIdOverride: true,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('DRIVER_ID_OVERRIDE_FORBIDDEN');
  });

  it('lets an admin waive the ID photo, and records it as a waiver', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer(
      {
        batchId,
        clientRequestId: randomUUID(),
        destination: toSite(siteB),
        scans: serials.map(scan),
        driverIdPhoto: null,
        driverIdOverride: true,
      },
      adminToken,
    );
    expect(res.statusCode).toBe(201);
    const { transfer } = res.json();
    expect(transfer.driverIdOverridden).toBe(true);
    expect(transfer.driverIdCaptured).toBe(false);
    // The number is still required — the waiver is of the camera, not of identity.
    expect(transfer.driverIdNumber).toBe('8801015009087');
  });

  it('keeps the photo when a submission carries both a photo and an override', async () => {
    // Real evidence outranks an assertion, exactly as a genuinely scanned serial
    // keeps its scan even when it also appears in overrideSerials.
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer(
      {
        batchId,
        clientRequestId: randomUUID(),
        destination: toSite(siteB),
        scans: serials.map(scan),
        driverIdOverride: true,
      },
      adminToken,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().transfer.driverIdCaptured).toBe(true);
    expect(res.json().transfer.driverIdOverridden).toBe(false);
  });
});

describe('POST /transfers — happy paths', () => {
  it('moves scanned cylinders to a site, records TRANSFER events, leaves the rest alone', async () => {
    const { batchId, serials } = await makeBatch(4);
    const moving = serials.slice(0, 3);

    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: moving.map(scan),
    });

    expect(res.statusCode).toBe(201);
    const { transfer, rejected } = res.json();
    expect(rejected).toEqual([]);
    expect(transfer.movedSerials).toEqual([...moving].sort());
    expect(transfer.destinationType).toBe('SITE');
    expect(transfer.destinationSiteId).toBe(siteB);
    expect(transfer.destinationSiteName).toBe('Yard B');

    const moved = await prisma.cylinder.findMany({
      where: { serialCode: { in: moving } },
      select: { status: true, currentSiteId: true },
    });
    expect(moved.every((c) => c.status === 'DEPLOYED' && c.currentSiteId === siteB)).toBe(true);

    // Only scanned cylinders move — partial operations are first-class.
    const untouched = await prisma.cylinder.findUniqueOrThrow({
      where: { serialCode: serials[3]! },
    });
    expect(untouched.status).toBe('IN_STORES');
    expect(untouched.currentSiteId).toBeNull();

    const events = await prisma.movementEvent.findMany({
      where: { transferId: transfer.id },
      include: { cylinder: { select: { serialCode: true } } },
    });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === 'TRANSFER')).toBe(true);
    // Intake left them at stores, so this hop starts from NULL.
    expect(events.every((e) => e.fromSiteId === null && e.toSiteId === siteB)).toBe(true);
  });

  it('moves cylinders back to stores (currentSiteId NULL, status IN_STORES)', async () => {
    const { batchId, serials } = await makeBatch(2);
    await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: serials.map(scan),
    });

    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toStores,
      scans: serials.map(scan),
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().transfer.destinationType).toBe('STORES');
    expect(res.json().transfer.destinationSiteId).toBeNull();

    const rows = await prisma.cylinder.findMany({ where: { serialCode: { in: serials } } });
    expect(rows.every((c) => c.status === 'IN_STORES' && c.currentSiteId === null)).toBe(true);

    // The second hop's origin must be the site the first hop delivered them to.
    const events = await prisma.movementEvent.findMany({
      where: { transferId: res.json().transfer.id },
    });
    expect(events.every((e) => e.fromSiteId === siteB && e.toSiteId === null)).toBe(true);
  });

  it('records deviceAt from the scan, not from server time', async () => {
    const { batchId, serials } = await makeBatch(1);
    const scannedAt = new Date(Date.now() - 3 * 60 * 60 * 1000); // scanned offline 3h ago

    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [{ ...scan(serials[0]!), scannedAt: scannedAt.toISOString() }],
    });
    expect(res.statusCode).toBe(201);

    const event = await prisma.movementEvent.findFirstOrThrow({
      where: { transferId: res.json().transfer.id },
    });
    expect(event.deviceAt.toISOString()).toBe(scannedAt.toISOString());
    expect(event.serverAt.getTime()).toBeGreaterThan(event.deviceAt.getTime());
  });

  it('allows a stores manager to transfer', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer(
      {
        batchId,
        clientRequestId: randomUUID(),
        destination: toSite(siteB),
        scans: serials.map(scan),
      },
      storesToken,
    );
    expect(res.statusCode).toBe(201);
  });
});

describe('POST /transfers — idempotency', () => {
  it('replaying the same clientRequestId returns the original transfer, not a second one', async () => {
    const { batchId, serials } = await makeBatch(2);
    const clientRequestId = randomUUID();
    const payload = {
      batchId,
      clientRequestId,
      destination: toSite(siteB),
      scans: serials.map(scan),
    };

    const first = await postTransfer(payload);
    expect(first.statusCode).toBe(201);

    const replay = await postTransfer(payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().transfer.id).toBe(first.json().transfer.id);
    expect(replay.json().transfer.movedSerials).toEqual([...serials].sort());

    expect(await prisma.transfer.count({ where: { clientRequestId } })).toBe(1);
    expect(
      await prisma.movementEvent.count({ where: { transferId: first.json().transfer.id } }),
    ).toBe(2);
  });

  it('concurrent replays of one queued transfer produce exactly one transfer', async () => {
    // A race probe, so it runs several independent rounds: the defect it guards
    // against only shows when a duplicate misses the pre-transaction idempotency
    // lookup but reads cylinder state AFTER the original committed. With the
    // Transfer insert placed after scan resolution, such a duplicate saw every
    // cylinder as ALREADY_AT_DESTINATION and returned 422 — a hard refusal that an
    // offline outbox can never clear. One round caught that only ~50% of the time, so this runs ten.
    for (let round = 0; round < 10; round++) {
      const { batchId, serials } = await makeBatch(3);
      const clientRequestId = randomUUID();
      const payload = {
        batchId,
        clientRequestId,
        destination: toSite(siteB),
        scans: serials.map(scan),
      };

      const results = await Promise.all(Array.from({ length: 6 }, () => postTransfer(payload)));

      // Every caller must get a usable answer — a retry must never 409 or 422.
      const statuses = results.map((r) => r.statusCode);
      expect(statuses.filter((s) => s !== 200 && s !== 201)).toEqual([]);

      const ids = new Set(results.map((r) => r.json().transfer.id));
      expect(ids.size).toBe(1);
      expect(await prisma.transfer.count({ where: { clientRequestId } })).toBe(1);
      expect(
        await prisma.movementEvent.count({ where: { cylinder: { batchId }, type: 'TRANSFER' } }),
      ).toBe(3);
    }
  });
});

describe('POST /transfers — per-serial scan validation', () => {
  it('rejects an unknown serial but still moves the valid ones', async () => {
    const { batchId, serials } = await makeBatch(2);
    const ghost = 'NIT99-999';

    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [...serials.map(scan), scan(ghost)],
    });

    expect(res.statusCode).toBe(201);
    const { transfer, rejected } = res.json();
    expect(transfer.movedSerials).toEqual([...serials].sort());
    expect(rejectionFor(rejected, ghost)?.code).toBe('UNKNOWN_SERIAL');
  });

  it('rejects a serial belonging to another batch', async () => {
    const mine = await makeBatch(1);
    const theirs = await makeBatch(1);

    const res = await postTransfer({
      batchId: mine.batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [scan(mine.serials[0]!), scan(theirs.serials[0]!)],
    });

    expect(res.statusCode).toBe(201);
    expect(rejectionFor(res.json().rejected, theirs.serials[0]!)?.code).toBe('WRONG_BATCH');

    const stranger = await prisma.cylinder.findUniqueOrThrow({
      where: { serialCode: theirs.serials[0]! },
    });
    expect(stranger.currentSiteId).toBeNull();
  });

  it('rejects a duplicate scan of the same cylinder', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [scan(serials[0]!), scan(serials[0]!)],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().transfer.movedSerials).toEqual([serials[0]]);
    expect(rejectionFor(res.json().rejected, serials[0]!)?.code).toBe('DUPLICATE_SCAN');
    expect(
      await prisma.movementEvent.count({ where: { transferId: res.json().transfer.id } }),
    ).toBe(1);
  });

  it('rejects a forged QR payload — a printed serial alone is not a scan', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [{ ...scan(serials[0]!), qrPayload: `GCT2|${serials[0]}|${'ab'.repeat(64)}` }],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('NO_VALID_SCANS');
    expect(res.json().error.details.rejected[0].code).toBe('BAD_QR_SIGNATURE');

    const untouched = await prisma.cylinder.findUniqueOrThrow({
      where: { serialCode: serials[0]! },
    });
    expect(untouched.currentSiteId).toBeNull();
  });

  it('rejects a payload whose signed serial differs from the reported one', async () => {
    const a = await makeBatch(1);
    const b = await makeBatch(1);

    const res = await postTransfer({
      batchId: a.batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      // A validly-signed label for b, submitted under a's serial.
      scans: [{ ...scan(a.serials[0]!), qrPayload: qrPayloadFor(b.serials[0]!) }],
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rejected[0].code).toBe('SERIAL_MISMATCH');
  });

  it('rejects a cylinder that is already at the destination', async () => {
    const { batchId, serials } = await makeBatch(1);
    const move = {
      batchId,
      destination: toSite(siteB),
      scans: serials.map(scan),
    };
    await postTransfer({ ...move, clientRequestId: randomUUID() });

    const res = await postTransfer({ ...move, clientRequestId: randomUUID() });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rejected[0].code).toBe('ALREADY_AT_DESTINATION');
  });

  it('rejects a returned cylinder as terminal', async () => {
    const { batchId, serials } = await makeBatch(1);
    await prisma.cylinder.update({
      where: { serialCode: serials[0]! },
      data: { status: 'RETURNED', currentSiteId: null },
    });

    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: serials.map(scan),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rejected[0].code).toBe('ALREADY_RETURNED');
  });

  it('creates no Transfer row when every scan is rejected', async () => {
    const before = await prisma.transfer.count();
    const { batchId } = await makeBatch(1);

    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [scan('NIT99-998')],
    });
    expect(res.statusCode).toBe(422);
    expect(await prisma.transfer.count()).toBe(before);
  });
});

describe('POST /transfers — request validation', () => {
  it('refuses a submission with no scans (the spec’s CRITICAL ENFORCEMENT)', async () => {
    const { batchId } = await makeBatch(1);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('refuses a SITE destination with no siteId', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: { type: 'SITE' },
      scans: serials.map(scan),
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a destination site in another project', async () => {
    const { batchId, serials } = await makeBatch(1);
    const res = await postTransfer({
      batchId,
      clientRequestId: randomUUID(),
      destination: toSite(foreignSiteId),
      scans: serials.map(scan),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_DESTINATION');
  });

  it('404s an unknown batch', async () => {
    const res = await postTransfer({
      batchId: 'does-not-exist',
      clientRequestId: randomUUID(),
      destination: toSite(siteB),
      scans: [scan('NIT26-001')],
    });
    expect(res.statusCode).toBe(404);
  });

  it('401s without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      payload: { batchId: 'x', clientRequestId: randomUUID(), destination: toStores, scans: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /transfers — concurrency', () => {
  it('two simultaneous transfers to the SAME site: one moves it, the other gets CONFLICT', async () => {
    const { batchId, serials } = await makeBatch(1);
    const serial = serials[0]!;
    const move = { batchId, destination: toSite(siteB), scans: [scan(serial)] };

    const [a, b] = await Promise.all([
      postTransfer({ ...move, clientRequestId: randomUUID() }),
      postTransfer({ ...move, clientRequestId: randomUUID() }),
    ]);

    // Both passed the JS pre-check (each read currentSiteId = null). Only the SQL
    // claim decides, and it re-evaluates its predicate under the row lock.
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
    const loser = a.statusCode === 422 ? a : b;
    expect(loser.json().error.details.rejected[0].code).toBe('CONFLICT');

    const events = await prisma.movementEvent.findMany({
      where: { cylinder: { serialCode: serial }, type: 'TRANSFER' },
    });
    expect(events).toHaveLength(1);
  });

  it('two simultaneous transfers to DIFFERENT sites both apply, and neither fabricates its origin', async () => {
    const { batchId, serials } = await makeBatch(1);
    const serial = serials[0]!;

    // Nothing here is illegal — the cylinder was scanned twice and sent two places,
    // so both hops are applied in whatever order the row lock grants. What must hold
    // is that the SECOND hop departs from where the FIRST one left it. Both requests
    // read `currentSiteId = null` before either wrote, so a claim that trusted its
    // own snapshot for `fromSiteId` would log a hop out of stores that never
    // happened, and the audit trail would no longer reconstruct.
    const [toA, toB] = await Promise.all([
      postTransfer({
        batchId,
        clientRequestId: randomUUID(),
        destination: toSite(siteA),
        scans: [scan(serial)],
      }),
      postTransfer({
        batchId,
        clientRequestId: randomUUID(),
        destination: toSite(siteB),
        scans: [scan(serial)],
      }),
    ]);
    expect([toA.statusCode, toB.statusCode]).toEqual([201, 201]);

    const events = await prisma.movementEvent.findMany({
      where: { cylinder: { serialCode: serial }, type: 'TRANSFER' },
      orderBy: { serverAt: 'asc' },
    });
    expect(events).toHaveLength(2);

    // The chain is contiguous: hop 1 starts at stores, hop 2 starts where hop 1 ended.
    expect(events[0]!.fromSiteId).toBeNull();
    expect(events[1]!.fromSiteId).toBe(events[0]!.toSiteId);

    // And the cylinder physically sits at the end of that chain.
    const cyl = await prisma.cylinder.findUniqueOrThrow({ where: { serialCode: serial } });
    expect(cyl.currentSiteId).toBe(events[1]!.toSiteId);
    expect(cyl.status).toBe('DEPLOYED');
  });
});
