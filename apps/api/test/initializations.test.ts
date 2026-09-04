import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ScanInput } from '@gct/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { qrPayloadFor } from '../src/services/qr.js';
import {
  loginAs,
  bearer,
  DEMO,
  initializeBatch,
  makeProjectManager,
  resetDb,
  supplierForGas,
  testPhoto,
  uniqueProjectNumber,
  testDriverId,
  testSignOff,
} from './helpers.js';

/**
 * Workflow A2 — the first scan, and the gate it opens.
 *
 * Two claims are under test here and they are separate:
 *   1. initialization is all-or-nothing and produces evidence (a photo, and one
 *      INITIALIZE event per cylinder that moves nothing);
 *   2. nothing else in the system will touch a batch until it has happened.
 */

let app: FastifyInstance;
let techToken: string;
let storesToken: string;
let adminToken: string;
let projectId: string;
let siteA: string;
let siteB: string;
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
      projectManagerId: (await makeProjectManager('Init PM')).id,
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

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  supplierId = await supplierForGas(nitrogenId);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** A batch that has NOT been initialized — the starting point for most of these. */
async function rawBatch(quantity: number): Promise<{ batchId: string; serials: string[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: {
      projectId,
      siteId: siteA,
      clientRequestId: randomUUID(),
      lines: [{ gasTypeId: nitrogenId, supplierId, quantity, initialDeliveryPoint: 'STORES' }],
    },
  });
  if (res.statusCode !== 201) throw new Error(`rawBatch failed: ${res.statusCode} ${res.body}`);
  return { batchId: res.json().batch.id, serials: res.json().serials };
}

const scan = (serialCode: string): ScanInput => ({
  serialCode,
  qrPayload: qrPayloadFor(serialCode),
  scannedAt: new Date().toISOString(),
});

const postInit = (payload: Record<string, unknown>, token = techToken) =>
  app.inject({
    method: 'POST',
    url: '/initializations',
    headers: bearer(token),
    payload: { photo: testPhoto(), ...payload },
  });

const initBody = (batchId: string, serials: string[], extra: Record<string, unknown> = {}) => ({
  batchId,
  clientRequestId: randomUUID(),
  scans: serials.map(scan),
  ...extra,
});

// ------------------------------------------------------------------ happy path

describe('POST /initializations', () => {
  it('records the first scan, stamps the batch, and writes one INITIALIZE event per cylinder', async () => {
    const { batchId, serials } = await rawBatch(3);

    const res = await postInit(initBody(batchId, serials));
    expect(res.statusCode).toBe(201);

    const { initialization, rejected } = res.json();
    expect(rejected).toEqual([]);
    expect(initialization.initializedSerials).toEqual([...serials].sort());
    expect(initialization.overriddenSerials).toEqual([]);
    expect(initialization.photoOverridden).toBe(false);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.initializedAt).not.toBeNull();

    const events = await prisma.movementEvent.findMany({
      where: { cylinder: { batchId }, type: 'INITIALIZE' },
    });
    expect(events).toHaveLength(3);
    // THE point: initialization is evidence that a cylinder was seen, not that it
    // moved. Every event must begin and end exactly where the cylinder already was.
    expect(events.every((e) => e.fromSiteId === null && e.toSiteId === null)).toBe(true);
    expect(events.every((e) => e.overridden === false)).toBe(true);

    const cylinders = await prisma.cylinder.findMany({ where: { batchId } });
    expect(cylinders.every((c) => c.status === 'IN_STORES' && c.currentSiteId === null)).toBe(true);
  });

  it('stores the photo with its position and both clocks', async () => {
    const { batchId, serials } = await rawBatch(1);
    const capturedAt = new Date(Date.now() - 3_600_000).toISOString(); // captured an hour ago

    const res = await postInit(
      initBody(batchId, serials, {
        photo: testPhoto({ capturedAt, latitude: -26.2041, longitude: 28.0473, accuracyM: 8 }),
      }),
    );
    expect(res.statusCode).toBe(201);

    const photoId = res.json().initialization.photo.id;
    const photo = await prisma.batchPhoto.findUniqueOrThrow({ where: { id: photoId } });
    expect(photo.latitude).toBeCloseTo(-26.2041);
    expect(photo.longitude).toBeCloseTo(28.0473);
    expect(photo.accuracyM).toBe(8);
    expect(photo.mimeType).toBe('image/jpeg');
    // Both clocks survive. The device's is kept as given — an hour behind the server's
    // — because that gap is the only signal that the work sat in an outbox.
    expect(photo.capturedAt.toISOString()).toBe(capturedAt);
    expect(photo.serverAt.getTime()).toBeGreaterThan(photo.capturedAt.getTime());
    expect(photo.batchId).toBe(batchId);
  });

  it('accepts a photo with no GPS fix, recording why rather than inventing a position', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await postInit(
      initBody(batchId, serials, {
        photo: testPhoto({
          latitude: null,
          longitude: null,
          accuracyM: null,
          locationError: 'Location permission denied',
        }),
      }),
    );
    expect(res.statusCode).toBe(201);

    const photo = res.json().initialization.photo;
    expect(photo.latitude).toBeNull();
    expect(photo.longitude).toBeNull();
    expect(photo.locationError).toBe('Location permission denied');
  });

  it('serves the stored image back, base64, with its stamp', async () => {
    const { batchId, serials } = await rawBatch(1);
    const created = await postInit(initBody(batchId, serials));
    const photoId = created.json().initialization.photo.id;

    const res = await app.inject({
      method: 'GET',
      url: `/batch-photos/${photoId}`,
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mimeType).toBe('image/jpeg');
    // Round-trips to real JPEG bytes, not to whatever the client happened to send.
    const bytes = Buffer.from(res.json().imageBase64, 'base64');
    expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(res.json().photo.id).toBe(photoId);
  });

  it('is idempotent — replaying the same clientRequestId returns the original', async () => {
    const { batchId, serials } = await rawBatch(2);
    const body = initBody(batchId, serials);

    const first = await postInit(body);
    expect(first.statusCode).toBe(201);
    const second = await postInit(body);
    expect(second.statusCode).toBe(200);
    expect(second.json().initialization.id).toBe(first.json().initialization.id);

    expect(await prisma.batchInitialization.count({ where: { batchId } })).toBe(1);
  });
});

// ------------------------------------------------------- all-or-nothing

describe('POST /initializations — it must cover the whole batch', () => {
  it('422s a partial scan and names what was missed, changing nothing', async () => {
    const { batchId, serials } = await rawBatch(4);

    const res = await postInit(initBody(batchId, serials.slice(0, 2)));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INCOMPLETE_INITIALIZATION');
    expect(res.json().error.details.missingSerials).toEqual([...serials.slice(2)].sort());

    // Rolled back whole: no record, no events, no stamp.
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.initializedAt).toBeNull();
    expect(await prisma.batchInitialization.count({ where: { batchId } })).toBe(0);
    expect(
      await prisma.movementEvent.count({ where: { cylinder: { batchId }, type: 'INITIALIZE' } }),
    ).toBe(0);
  });

  it('409s a batch that is already initialized', async () => {
    const { batchId, serials } = await rawBatch(1);
    await initializeBatch(app, techToken, batchId, serials);

    const res = await postInit(initBody(batchId, serials));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_INITIALIZED');
  });
});

// ------------------------------------------------------- the two overrides

describe('POST /initializations — overrides', () => {
  it('lets an admin initialize without scanning, and marks those events as unscanned', async () => {
    const { batchId, serials } = await rawBatch(2);

    const res = await postInit(
      { batchId, clientRequestId: randomUUID(), scans: [], overrideSerials: serials },
      adminToken,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().initialization.overriddenSerials).toEqual([...serials].sort());

    const events = await prisma.movementEvent.findMany({
      where: { cylinder: { batchId }, type: 'INITIALIZE' },
    });
    expect(events.every((e) => e.overridden)).toBe(true);
  });

  it('403s a technician who tries the scan override', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await postInit({
      batchId,
      clientRequestId: randomUUID(),
      scans: [],
      overrideSerials: serials,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('OVERRIDE_FORBIDDEN');
  });

  it('lets an admin override the CAMERA, and records that no photo was taken', async () => {
    const { batchId, serials } = await rawBatch(1);

    const res = await postInit(
      initBody(batchId, serials, { photo: null, photoOverride: true }),
      adminToken,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().initialization.photo).toBeNull();
    // The record says an admin waved it through. It does not look like a photo exists.
    expect(res.json().initialization.photoOverridden).toBe(true);
    expect(await prisma.batchPhoto.count({ where: { batchId } })).toBe(0);
  });

  it('403s a technician who tries the camera override', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await postInit(initBody(batchId, serials, { photo: null, photoOverride: true }));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PHOTO_OVERRIDE_FORBIDDEN');
  });

  it('400s a submission with no photo and no override at all', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await postInit(initBody(batchId, serials, { photo: null }));
    expect(res.statusCode).toBe(400);
  });

  it('400s a photo whose bytes are not an image', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await postInit(
      initBody(batchId, serials, {
        photo: testPhoto({ imageBase64: Buffer.from('x'.repeat(200)).toString('base64') }),
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PHOTO');
  });

  it('keeps the photo when a request carries both a photo and an override', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await postInit(initBody(batchId, serials, { photoOverride: true }), adminToken);
    expect(res.statusCode).toBe(201);
    // Real evidence outranks the assertion, exactly as a scanned serial outranks its
    // presence in overrideSerials.
    expect(res.json().initialization.photo).not.toBeNull();
    expect(res.json().initialization.photoOverridden).toBe(false);
  });
});

// ------------------------------------------------------- the gate

describe('an uninitialized batch is inert', () => {
  it('409s a transfer', async () => {
    const { batchId, serials } = await rawBatch(2);
    const res = await app.inject({
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
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BATCH_NOT_INITIALIZED');
    expect(await prisma.transfer.count({ where: { batchId } })).toBe(0);
  });

  it('409s a return', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        scans: serials.map(scan),
        driverName: 'Sipho Ndlovu',
        ...testDriverId(),
        signaturePng: `data:image/png;base64,${Buffer.from([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
          ...Array.from({ length: 64 }, () => 0),
        ]).toString('base64')}`,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BATCH_NOT_INITIALIZED');
  });

  it('is refused even for an admin using the scan override — the gate is not about scanning', async () => {
    const { batchId, serials } = await rawBatch(1);
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(adminToken),
      payload: {
        ...testSignOff(),
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'STORES' },
        scans: [],
        overrideSerials: serials,
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('drops out of the transfer and returns pickers, and is the only thing Initialize shows', async () => {
    const fresh = await rawBatch(1);
    const ready = await rawBatch(1);
    await initializeBatch(app, techToken, ready.batchId, ready.serials);

    const list = async (scope: string): Promise<string[]> => {
      const res = await app.inject({
        method: 'GET',
        url: `/batches?scope=${scope}&projectId=${projectId}&status=all`,
        headers: bearer(techToken),
      });
      return (res.json().batches as { id: string }[]).map((b) => b.id);
    };

    expect(await list('transfer')).toContain(ready.batchId);
    expect(await list('transfer')).not.toContain(fresh.batchId);
    expect(await list('returns')).not.toContain(fresh.batchId);

    expect(await list('initialize')).toContain(fresh.batchId);
    expect(await list('initialize')).not.toContain(ready.batchId);

    // History hides nothing — it is the record of everything.
    expect(await list('history')).toEqual(expect.arrayContaining([fresh.batchId, ready.batchId]));
  });
});

// ------------------------------------------------------- transfers/returns photos

describe('transfers and returns carry the same evidence', () => {
  it('attaches the photo to the transfer that produced it', async () => {
    const { batchId, serials } = await rawBatch(2);
    await initializeBatch(app, techToken, batchId, serials);

    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        ...testSignOff(),
        photo: testPhoto({ latitude: -25.75, longitude: 28.19, accuracyM: 5 }),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId: siteB },
        scans: serials.map(scan),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transfer.photo.latitude).toBeCloseTo(-25.75);
    expect(res.json().transfer.photoOverridden).toBe(false);

    const photo = await prisma.batchPhoto.findFirstOrThrow({
      where: { transferId: res.json().transfer.id },
    });
    // The CHECK constraint's whole job: a photo points at exactly one event.
    expect(photo.initializationId).toBeNull();
    expect(photo.returnRecordId).toBeNull();
  });

  it('403s a technician transferring without a photo', async () => {
    const { batchId, serials } = await rawBatch(1);
    await initializeBatch(app, techToken, batchId, serials);

    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        ...testSignOff(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId: siteB },
        scans: serials.map(scan),
        photo: null,
        photoOverride: true,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PHOTO_OVERRIDE_FORBIDDEN');
  });
});

// ------------------------------------------------------- admin interaction

describe('admin corrections and the initialization flag', () => {
  it('still allows a correction to a batch that has only been initialized', async () => {
    const { batchId, serials } = await rawBatch(2);
    await initializeBatch(app, techToken, batchId, serials);
    const batch = await prisma.batch.findUniqueOrThrow({
      where: { id: batchId },
      include: { lines: true },
    });

    // Being scanned in is not a movement, so the line is still correctable. If this
    // ever fails, admins can no longer fix any batch that reached a usable state.
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { lines: [{ id: batch.lines[0]!.id, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.cylinder.count({ where: { batchId } })).toBe(1);
  });

  it('un-initializes a batch when an admin adds cylinders to it', async () => {
    const { batchId, serials } = await rawBatch(1);
    await initializeBatch(app, techToken, batchId, serials);
    const batch = await prisma.batch.findUniqueOrThrow({
      where: { id: batchId },
      include: { lines: true },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { lines: [{ id: batch.lines[0]!.id, quantity: 3 }] },
    });
    expect(res.statusCode).toBe(200);

    // The two new cylinders have never had a label printed, let alone scanned. The
    // batch must not keep claiming every cylinder in it was verified.
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(after.initializedAt).toBeNull();

    const amendment = await prisma.batchAmendment.findFirstOrThrow({
      where: { batchId },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(amendment.changes)).toContain('re-initialized');
  });
});
