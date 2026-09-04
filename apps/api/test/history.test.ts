import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  batchEventDetailResponseSchema,
  batchHistoryResponseSchema,
  cylinderHistoryResponseSchema,
  historyFeedResponseSchema,
  type MovementEventDto,
  type ScanInput,
} from '@gct/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { qrPayloadFor } from '../src/services/qr.js';
import {
  loginAs,
  bearer,
  DEMO,
  DEMO_NAMES,
  initializeBatch,
  makeProjectManager,
  resetDb,
  supplierForGas,
  testPhoto,
  uniqueProjectNumber,
  testDriverId,
} from './helpers.js';

/**
 * M5 audit trail. The narrative's justification for mandatory scanning is being able
 * to prove where a cylinder went — so these tests care less about response shape than
 * about the chain being *contiguous*: every hop's origin must be the previous hop's
 * destination, with no fabricated links.
 */

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: FastifyInstance;
let techToken: string;
let storesToken: string;
let projectId: string;
let siteA: string;
let siteB: string;
let nitrogenId: string;
let supplierId: string;
let projectNumber: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);

  projectNumber = uniqueProjectNumber();
  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber,
      projectManagerId: (await makeProjectManager('History PM')).id,
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

const scan = (serialCode: string): ScanInput => ({
  serialCode,
  qrPayload: qrPayloadFor(serialCode),
  scannedAt: new Date().toISOString(),
});

async function makeBatch(
  quantity: number,
): Promise<{ batchId: string; serials: string[]; first: string }> {
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
  const serials = res.json().serials as string[];
  const batchId = res.json().batch.id as string;

  // Scan the batch in so it is legal to move. Transfers and returns refuse an
  // uninitialized batch (409), which is the point of the step — but it is not what
  // any test below is about, so it happens here once.
  await initializeBatch(app, techToken, batchId, serials);
  // `noUncheckedIndexedAccess` is on and cannot see that N cylinders yield N serials,
  // so hand the first one back explicitly rather than asserting at every use site.
  return { batchId, serials, first: serials[0]! };
}

const transferTo = (batchId: string, serials: string[], siteId: string | null) =>
  app.inject({
    method: 'POST',
    url: '/transfers',
    headers: bearer(techToken),
    payload: {
      photo: testPhoto(),
      batchId,
      clientRequestId: randomUUID(),
      destination: siteId ? { type: 'SITE', siteId } : { type: 'STORES' },
      scans: serials.map(scan),
    },
  });

const returnAll = (batchId: string, serials: string[]) =>
  app.inject({
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
      signaturePng: `data:image/png;base64,${PNG_1X1}`,
    },
  });

const getCylinderHistory = (serialCode: string, token = techToken) =>
  app.inject({
    method: 'GET',
    url: `/cylinders/${serialCode}/history`,
    headers: bearer(token),
  });

describe('GET /cylinders/:serialCode/history', () => {
  it('reconstructs a full lifecycle as a contiguous chain', async () => {
    const { batchId, first: serial } = await makeBatch(2);

    await transferTo(batchId, [serial], siteA);
    await transferTo(batchId, [serial], siteB);
    await transferTo(batchId, [serial], null); // back to stores
    await returnAll(batchId, [serial]);

    const res = await getCylinderHistory(serial);
    expect(res.statusCode).toBe(200);

    // The contract the mobile view is typed against — parse, don't just eyeball.
    const body = cylinderHistoryResponseSchema.parse(res.json());

    expect(body.cylinder.serialCode).toBe(serial);
    expect(body.cylinder.status).toBe('RETURNED');
    expect(body.batch.projectNumber).toBe(projectNumber);
    // The feed header summarises the whole batch, which may hold several gases.
    expect(body.batch.contents).toContain('Nitrogen');

    // INITIALIZE sits between the booking-in and the first move: it is the scan that
    // proved the printed label was physically on this cylinder, and it moves nothing.
    expect(body.events.map((e) => e.type)).toEqual([
      'INTAKE',
      'INITIALIZE',
      'TRANSFER',
      'TRANSFER',
      'TRANSFER',
      'RETURN',
    ]);
    // Intake lands cylinders IN_STORES — the batch's site is where they are *destined*,
    // not where they are — so the chain starts at Stores, not at Yard A. INITIALIZE
    // leaves it there, which is exactly what makes it not a movement.
    expect(body.events.map((e) => e.toName)).toEqual([
      'Stores',
      'Stores',
      'Yard A',
      'Yard B',
      'Stores',
      'Stores',
    ]);

    // THE invariant: no hop may claim an origin the cylinder was not actually at.
    // A fabricated `fromSiteId` (see the M3 read-through-the-lock bug) breaks exactly
    // this, and nothing else in the suite would notice.
    const hops = body.events.slice(1);
    for (const [i, hop] of hops.entries()) {
      expect(hop.fromName).toBe(body.events[i]!.toName);
    }
  });

  it('attributes every hop to the user who submitted it', async () => {
    const { batchId, serials, first } = await makeBatch(1);
    await transferTo(batchId, serials, siteB); // technician
    await returnAll(batchId, serials); // stores manager

    const body = cylinderHistoryResponseSchema.parse((await getCylinderHistory(first)).json());
    const by = (type: MovementEventDto['type']) =>
      body.events.find((e) => e.type === type)?.userName;

    expect(by('TRANSFER')).toBe(DEMO_NAMES.technician);
    expect(by('RETURN')).toBe(DEMO_NAMES.stores);
  });

  it('links each hop to the Transfer or ReturnRecord that produced it', async () => {
    const { batchId, serials, first } = await makeBatch(1);
    const transferId = (await transferTo(batchId, serials, siteB)).json().transfer.id;
    const returnId = (await returnAll(batchId, serials)).json().returnRecord.id;

    const body = cylinderHistoryResponseSchema.parse((await getCylinderHistory(first)).json());
    const intake = body.events.find((e) => e.type === 'INTAKE');
    const transfer = body.events.find((e) => e.type === 'TRANSFER');
    const ret = body.events.find((e) => e.type === 'RETURN');

    expect(intake?.transferId).toBeNull();
    expect(intake?.returnRecordId).toBeNull();
    expect(transfer?.transferId).toBe(transferId);
    expect(transfer?.returnRecordId).toBeNull();
    expect(ret?.returnRecordId).toBe(returnId);
    expect(ret?.transferId).toBeNull();
  });

  it('reports a live cylinder as being at its current site', async () => {
    const { batchId, serials, first } = await makeBatch(1);
    await transferTo(batchId, serials, siteB);

    const body = cylinderHistoryResponseSchema.parse((await getCylinderHistory(first)).json());
    expect(body.cylinder.status).toBe('DEPLOYED');
    expect(body.cylinder.currentSiteId).toBe(siteB);
    expect(body.cylinder.currentLocation).toBe('Yard B');
  });

  it('distinguishes "returned to supplier" from "sitting in stores"', async () => {
    const inStores = await makeBatch(1);
    const returned = await makeBatch(1);
    await returnAll(returned.batchId, returned.serials);

    const a = cylinderHistoryResponseSchema.parse(
      (await getCylinderHistory(inStores.first)).json(),
    );
    const b = cylinderHistoryResponseSchema.parse(
      (await getCylinderHistory(returned.first)).json(),
    );

    // Both have currentSiteId === null; only the location text tells them apart.
    expect(a.cylinder.currentSiteId).toBeNull();
    expect(b.cylinder.currentSiteId).toBeNull();
    expect(a.cylinder.currentLocation).toBe('Stores');
    expect(b.cylinder.currentLocation).toBe('Returned to supplier');
  });

  it('accepts a lower-case serial from a hand-typed lookup', async () => {
    const { first } = await makeBatch(1);
    const res = await getCylinderHistory(first.toLowerCase());
    expect(res.statusCode).toBe(200);
    expect(res.json().cylinder.serialCode).toBe(first);
  });

  it('404s an unknown serial rather than returning an empty chain', async () => {
    const res = await getCylinderHistory('NIT26-999');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('requires authentication', async () => {
    const { first } = await makeBatch(1);
    const res = await app.inject({ method: 'GET', url: `/cylinders/${first}/history` });
    expect(res.statusCode).toBe(401);
  });

  it('is readable by every role — a technician can audit what they scanned', async () => {
    const { first } = await makeBatch(1);
    for (const email of [DEMO.technician, DEMO.stores, DEMO.admin]) {
      const token = await loginAs(app, email);
      expect((await getCylinderHistory(first, token)).statusCode).toBe(200);
    }
  });
});

describe('GET /batches/:id/history', () => {
  it('returns every cylinder’s hops, newest first', async () => {
    const { batchId, serials } = await makeBatch(3);
    await transferTo(batchId, serials, siteB);

    const res = await app.inject({
      method: 'GET',
      url: `/batches/${batchId}/history`,
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(200);
    const body = batchHistoryResponseSchema.parse(res.json());

    expect(body.batch.id).toBe(batchId);
    expect(body.events).toHaveLength(9); // 3 INTAKE + 3 INITIALIZE + 3 TRANSFER
    expect(body.events.slice(0, 3).every((e) => e.type === 'TRANSFER')).toBe(true);
    expect(body.events.slice(3, 6).every((e) => e.type === 'INITIALIZE')).toBe(true);
    expect(body.events.slice(6).every((e) => e.type === 'INTAKE')).toBe(true);

    // Within one transaction every event shares `serverAt`; serial breaks the tie, so
    // the order must be stable rather than whatever the planner returns.
    expect(body.events.slice(0, 3).map((e) => e.serialCode)).toEqual([...serials].sort());
  });

  it('is stable across repeated requests', async () => {
    const { batchId, serials } = await makeBatch(4);
    await transferTo(batchId, serials, siteB);

    const ids = async (): Promise<string[]> => {
      const r = await app.inject({
        method: 'GET',
        url: `/batches/${batchId}/history`,
        headers: bearer(techToken),
      });
      return (r.json().events as MovementEventDto[]).map((e) => e.id);
    };
    expect(await ids()).toEqual(await ids());
  });

  it('shows a batch that has only been booked in and scanned in, with nothing moved', async () => {
    const { batchId } = await makeBatch(2);
    const res = await app.inject({
      method: 'GET',
      url: `/batches/${batchId}/history`,
      headers: bearer(techToken),
    });
    const body = batchHistoryResponseSchema.parse(res.json());
    expect(body.events).toHaveLength(4); // 2 INTAKE + 2 INITIALIZE
    // Neither type is a movement, so every event begins and ends at Stores.
    expect(
      body.events.every(
        (e) =>
          (e.type === 'INTAKE' || e.type === 'INITIALIZE') &&
          e.fromName === 'Stores' &&
          e.toName === 'Stores',
      ),
    ).toBe(true);
  });

  it('404s an unknown batch', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/batches/does-not-exist/history',
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The History section proper: a feed of EVENTS, read-only.
// ---------------------------------------------------------------------------

describe('GET /history — the event feed', () => {
  it('renders each change as its own row, newest first, with a headline', async () => {
    const { batchId, serials } = await makeBatch(3);
    await transferTo(batchId, serials, siteB);
    await returnAll(batchId, serials);

    const res = await app.inject({
      method: 'GET',
      url: `/history?batchId=${batchId}`,
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(200);
    const body = historyFeedResponseSchema.parse(res.json());

    // The batch's whole life, as four separate things that happened to it — not as
    // one row saying where it ended up.
    expect(body.events.map((e) => e.kind)).toEqual([
      'RETURN',
      'TRANSFER',
      'INITIALIZED',
      'CREATED',
    ]);
    expect(body.events.every((e) => e.batchId === batchId)).toBe(true);
    expect(body.events.every((e) => e.projectNumber === projectNumber)).toBe(true);

    const transfer = body.events.find((e) => e.kind === 'TRANSFER')!;
    expect(transfer.headline).toBe('3 cylinders moved to Yard B');
    expect(transfer.cylinderCount).toBe(3);
    expect(transfer.hasPhoto).toBe(true);

    const created = body.events.find((e) => e.kind === 'CREATED')!;
    // Nothing exists to photograph when a batch is booked in at a desk, which is
    // exactly why initialization is a separate step.
    expect(created.hasPhoto).toBe(false);
    expect(created.photoOverridden).toBe(false);
  });

  it('filters by kind', async () => {
    const { batchId, serials } = await makeBatch(1);
    await transferTo(batchId, serials, siteB);

    const res = await app.inject({
      method: 'GET',
      url: `/history?batchId=${batchId}&kind=TRANSFER`,
      headers: bearer(techToken),
    });
    const body = historyFeedResponseSchema.parse(res.json());
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.kind).toBe('TRANSFER');
  });

  it('searches by project number, and a search that matches nothing returns nothing', async () => {
    const { batchId } = await makeBatch(1);

    const hit = await app.inject({
      method: 'GET',
      url: `/history?q=${encodeURIComponent(projectNumber)}`,
      headers: bearer(techToken),
    });
    expect(
      historyFeedResponseSchema.parse(hit.json()).events.some((e) => e.batchId === batchId),
    ).toBe(true);

    // A search with no matches must be an empty feed — not, by falling through, the
    // whole system's.
    const miss = await app.inject({
      method: 'GET',
      url: '/history?q=999999-999-9-99',
      headers: bearer(techToken),
    });
    expect(historyFeedResponseSchema.parse(miss.json()).events).toEqual([]);
  });

  it('shows an admin correction as its own event', async () => {
    const { batchId } = await makeBatch(2);
    const batch = await prisma.batch.findUniqueOrThrow({
      where: { id: batchId },
      include: { lines: true },
    });
    const adminToken = await loginAs(app, DEMO.admin);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: {
        lines: [{ id: batch.lines[0]!.id, quantity: 1 }],
        reason: 'Miscounted on arrival',
      },
    });
    expect(patched.statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: `/history?batchId=${batchId}&kind=AMENDED`,
      headers: bearer(techToken),
    });
    const body = historyFeedResponseSchema.parse(res.json());
    expect(body.events).toHaveLength(1);
    // Correcting the record IS a change to the batch, so History has to show it —
    // otherwise the section that exists to say what happened would be the one place a
    // change could hide.
    expect(body.events[0]!.detail).toContain('quantity');
  });
});

describe('GET /history/events/:kind/:id — one change in full', () => {
  it('carries the serials and the photo stamp the feed row omits', async () => {
    const { batchId, serials } = await makeBatch(2);
    await transferTo(batchId, serials, siteB);

    const feed = await app.inject({
      method: 'GET',
      url: `/history?batchId=${batchId}&kind=TRANSFER`,
      headers: bearer(techToken),
    });
    const row = historyFeedResponseSchema.parse(feed.json()).events[0]!;

    const res = await app.inject({
      method: 'GET',
      url: `/history/events/${row.kind}/${row.recordId}`,
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(200);
    const { event } = batchEventDetailResponseSchema.parse(res.json());

    // The header must say exactly what the row the user tapped said.
    expect(event.headline).toBe(row.headline);
    expect(event.id).toBe(row.id);

    expect(event.serials).toEqual([...serials].sort());
    expect(event.destinationName).toBe('Yard B');
    expect(event.photo).not.toBeNull();
    expect(event.photo!.latitude).toBeCloseTo(-26.2041);
    expect(event.photo!.userName).toBeTruthy();
  });

  it('lists the serials a batch was created with', async () => {
    const { batchId, serials } = await makeBatch(2);
    const res = await app.inject({
      method: 'GET',
      url: `/history/events/CREATED/${batchId}`,
      headers: bearer(techToken),
    });
    const { event } = batchEventDetailResponseSchema.parse(res.json());
    expect(event.kind).toBe('CREATED');
    expect(event.serials).toEqual([...serials].sort());
    expect(event.photo).toBeNull();
  });

  it('404s an unknown record and 400s an unknown kind', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/history/events/TRANSFER/does-not-exist',
      headers: bearer(techToken),
    });
    expect(unknown.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'GET',
      url: '/history/events/EXPLODED/whatever',
      headers: bearer(techToken),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('is read-only — History exposes no way to change anything', async () => {
    const { batchId } = await makeBatch(1);
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT'] as const) {
      const res = await app.inject({
        method,
        url: `/history/events/CREATED/${batchId}`,
        headers: bearer(await loginAs(app, DEMO.admin)),
        payload: {},
      });
      // 404 = no such route. Not even an admin has a verb here.
      expect(res.statusCode).toBe(404);
    }
  });
});
