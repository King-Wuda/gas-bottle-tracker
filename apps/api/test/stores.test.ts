import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ScanInput, StoresSummaryResponse } from '@gct/shared';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { qrPayloadFor } from '../src/services/qr.js';
import { processPendingEmails } from '../src/services/emailWorker.js';
import { capturedMail, clearCapturedMail } from '../src/services/mailer/index.js';
import {
  bearer,
  DEMO,
  loginAs,
  makeProjectManager,
  resetDb,
  supplierForGas,
  testPhoto,
  testSignOff,
  TEST_DRIVER_PHONE,
  TEST_DRIVER_EMAIL,
  uniqueProjectNumber,
} from './helpers.js';

/**
 * Stores cages, full/empty cylinders, the driver's phone number, and the email a
 * project manager gets on every transfer.
 *
 * The life being tested: a batch is booked in full, initialized into a cage chosen per
 * gas, sent to site (out of its cage), and transferred back with some cylinders
 * marked empty and each gas put into a cage. A return to the supplier takes cylinders
 * out of rotation altogether.
 */

let app: FastifyInstance;
let techToken: string;
let storesToken: string;
let projectId: string;
let siteId: string;
let pm: { id: string; email: string };
let nitrogenId: string;
let argonId: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);

  pm = await makeProjectManager('Stores PM');
  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: pm.id,
      clientName: 'Cage Client',
      location: 'Durban',
    },
  });
  projectId = created.json().project.id;
  siteId = created.json().project.sites[0].id;

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  const gases = gt.json().gasTypes as { id: string; name: string }[];
  nitrogenId = gases.find((g) => g.name === 'Nitrogen')!.id;
  argonId = gases.find((g) => g.name === 'Argon')!.id;
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

/** A batch of argon and nitrogen, each line delivered where asked. Not initialized. */
async function makeBatch(
  argon: { qty: number; to: 'STORES' | 'SITE' },
  nitrogen: { qty: number; to: 'STORES' | 'SITE' },
): Promise<{ batchId: string; argon: string[]; nitrogen: string[] }> {
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
          gasTypeId: argonId,
          supplierId: await supplierForGas(argonId),
          quantity: argon.qty,
          initialDeliveryPoint: argon.to,
        },
        {
          gasTypeId: nitrogenId,
          supplierId: await supplierForGas(nitrogenId),
          quantity: nitrogen.qty,
          initialDeliveryPoint: nitrogen.to,
        },
      ],
    },
  });
  if (res.statusCode !== 201) throw new Error(`makeBatch: ${res.statusCode} ${res.body}`);
  const batchId = res.json().batch.id as string;
  const cylinders = await prisma.cylinder.findMany({
    where: { batchId },
    select: { serialCode: true, gasTypeId: true },
    orderBy: { serialCode: 'asc' },
  });
  return {
    batchId,
    argon: cylinders.filter((c) => c.gasTypeId === argonId).map((c) => c.serialCode),
    nitrogen: cylinders.filter((c) => c.gasTypeId === nitrogenId).map((c) => c.serialCode),
  };
}

const initialize = (batchId: string, serials: string[], cages: unknown[]) =>
  app.inject({
    method: 'POST',
    url: '/initializations',
    headers: bearer(techToken),
    payload: {
      batchId,
      clientRequestId: randomUUID(),
      scans: serials.map(scan),
      photo: testPhoto(),
      cages,
    },
  });

const transfer = (payload: Record<string, unknown>, token = techToken) =>
  app.inject({
    method: 'POST',
    url: '/transfers',
    headers: bearer(token),
    payload: { ...testSignOff(), photo: testPhoto(), clientRequestId: randomUUID(), ...payload },
  });

const cylinder = (serialCode: string) =>
  prisma.cylinder.findUniqueOrThrow({ where: { serialCode } });

const summary = async (token = storesToken): Promise<StoresSummaryResponse> => {
  const res = await app.inject({ method: 'GET', url: '/stores/summary', headers: bearer(token) });
  expect(res.statusCode).toBe(200);
  return res.json();
};

// ------------------------------------------------------------- initialization

describe('initialization — into a cage per gas', () => {
  it('puts each gas booked into stores into its own cage, and site deliveries into none', async () => {
    const b = await makeBatch({ qty: 2, to: 'STORES' }, { qty: 2, to: 'SITE' });
    const res = await initialize(
      b.batchId,
      [...b.argon, ...b.nitrogen],
      [{ gasTypeId: argonId, cage: 2 }],
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().initialization.cages).toEqual([
      { gasTypeId: argonId, gasTypeName: 'Argon', cage: 2 },
    ]);

    for (const s of b.argon) expect(await cylinder(s)).toMatchObject({ cage: 2, contents: 'FULL' });
    for (const s of b.nitrogen) expect((await cylinder(s)).cage).toBeNull();
  });

  it('refuses to initialize without a cage for a gas going into stores', async () => {
    const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'STORES' });
    const res = await initialize(
      b.batchId,
      [...b.argon, ...b.nitrogen],
      [{ gasTypeId: argonId, cage: 1 }],
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CAGE_REQUIRED');
    expect(res.json().error.details.gasTypeIds).toEqual([nitrogenId]);
    expect(
      (await prisma.batch.findUniqueOrThrow({ where: { id: b.batchId } })).initializedAt,
    ).toBeNull();
  });

  it('refuses a cage for a gas that went straight to site', async () => {
    const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'SITE' });
    const res = await initialize(
      b.batchId,
      [...b.argon, ...b.nitrogen],
      [
        { gasTypeId: argonId, cage: 1 },
        { gasTypeId: nitrogenId, cage: 3 },
      ],
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CAGE_NOT_NEEDED');
  });

  it('refuses cage 4 and the same gas twice', async () => {
    const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'SITE' });
    const all = [...b.argon, ...b.nitrogen];
    expect((await initialize(b.batchId, all, [{ gasTypeId: argonId, cage: 4 }])).statusCode).toBe(
      400,
    );
    const twice = await initialize(b.batchId, all, [
      { gasTypeId: argonId, cage: 1 },
      { gasTypeId: argonId, cage: 2 },
    ]);
    expect(twice.statusCode).toBe(400);
  });
});

// ------------------------------------------------------------------ transfers

describe('transfers — out of the cage, and back in full or empty', () => {
  /** 3 argon + 2 nitrogen, initialized into cage 1, then all sent to site. */
  async function onSite() {
    const b = await makeBatch({ qty: 3, to: 'STORES' }, { qty: 2, to: 'STORES' });
    const all = [...b.argon, ...b.nitrogen];
    const init = await initialize(b.batchId, all, [
      { gasTypeId: argonId, cage: 1 },
      { gasTypeId: nitrogenId, cage: 1 },
    ]);
    expect(init.statusCode).toBe(201);
    const out = await transfer({
      batchId: b.batchId,
      destination: { type: 'SITE', siteId },
      scans: all.map(scan),
    });
    expect(out.statusCode).toBe(201);
    return { ...b, all };
  }

  it('a cylinder sent to site leaves its cage', async () => {
    const b = await onSite();
    for (const s of b.all) {
      expect(await cylinder(s)).toMatchObject({ status: 'DEPLOYED', cage: null });
    }
  });

  it('back to stores: each gas into its cage, the ones marked empty recorded EMPTY', async () => {
    const b = await onSite();
    // Took 3 argon to site, only one was used.
    const res = await transfer({
      batchId: b.batchId,
      destination: { type: 'STORES' },
      scans: b.all.map(scan),
      cages: [
        { gasTypeId: argonId, cage: 2 },
        { gasTypeId: nitrogenId, cage: 3 },
      ],
      emptySerials: [b.argon[0]!, b.nitrogen[1]!],
    });
    expect(res.statusCode).toBe(201);
    const t = res.json().transfer;
    expect(t.cages).toEqual([
      { gasTypeId: argonId, gasTypeName: 'Argon', cage: 2 },
      { gasTypeId: nitrogenId, gasTypeName: 'Nitrogen', cage: 3 },
    ]);
    expect(t.emptySerials.sort()).toEqual([b.argon[0], b.nitrogen[1]].sort());
    expect(t.driverPhone).toBe(TEST_DRIVER_PHONE);

    expect(await cylinder(b.argon[0]!)).toMatchObject({
      status: 'IN_STORES',
      cage: 2,
      contents: 'EMPTY',
    });
    expect(await cylinder(b.argon[1]!)).toMatchObject({ cage: 2, contents: 'FULL' });
    expect(await cylinder(b.nitrogen[0]!)).toMatchObject({ cage: 3, contents: 'FULL' });
    expect(await cylinder(b.nitrogen[1]!)).toMatchObject({ cage: 3, contents: 'EMPTY' });

    // The movement log keeps a snapshot, so History says where it went that day even
    // after the cylinder has moved on.
    const events = await prisma.movementEvent.findMany({ where: { transferId: t.id } });
    expect(events.every((e) => e.cage === 2 || e.cage === 3)).toBe(true);
    expect(events.filter((e) => e.contents === 'EMPTY')).toHaveLength(2);

    // ...and History's event detail shows the same.
    const detail = await app.inject({
      method: 'GET',
      url: `/history/events/TRANSFER/${t.id}`,
      headers: bearer(techToken),
    });
    expect(detail.json().event).toMatchObject({
      driverPhone: TEST_DRIVER_PHONE,
      cages: t.cages,
    });
    expect(detail.json().event.emptySerials.sort()).toEqual(t.emptySerials.sort());
  });

  it('refuses a move back to stores without a cage for a gas that moved, and moves nothing', async () => {
    const b = await onSite();
    const res = await transfer({
      batchId: b.batchId,
      destination: { type: 'STORES' },
      scans: b.all.map(scan),
      cages: [{ gasTypeId: argonId, cage: 1 }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CAGE_REQUIRED');
    for (const s of b.all) expect((await cylinder(s)).status).toBe('DEPLOYED');
    expect(await prisma.transfer.count({ where: { batchId: b.batchId } })).toBe(1);
  });

  it('a cage for a gas that did not move is not an error', async () => {
    const b = await onSite();
    const res = await transfer({
      batchId: b.batchId,
      destination: { type: 'STORES' },
      scans: b.argon.map(scan),
      cages: [
        { gasTypeId: argonId, cage: 1 },
        { gasTypeId: nitrogenId, cage: 2 },
      ],
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses cages or empties on a move to a site', async () => {
    const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'STORES' });
    const res = await transfer({
      batchId: b.batchId,
      destination: { type: 'SITE', siteId },
      scans: b.argon.map(scan),
      emptySerials: b.argon,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('STORES_ONLY');
  });

  it('the database refuses a cage on a cylinder that is not in stores', async () => {
    const b = await onSite();
    await expect(
      prisma.cylinder.update({ where: { serialCode: b.all[0]! }, data: { cage: 1 } }),
    ).rejects.toThrow();
  });
});

// ------------------------------------------------------------- the driver's phone

describe("the driver's phone number", () => {
  it('is required on a transfer and on a return', async () => {
    const b = await makeBatch({ qty: 1, to: 'SITE' }, { qty: 1, to: 'SITE' });
    const { driverPhone: _omit, ...withoutPhone } = testSignOff();
    void _omit;
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        ...withoutPhone,
        photo: testPhoto(),
        clientRequestId: randomUUID(),
        batchId: b.batchId,
        destination: { type: 'STORES' },
        scans: [],
        overrideSerials: b.argon,
      },
    });
    expect(res.statusCode).toBe(400);

    const ret = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        ...withoutPhone,
        photo: testPhoto(),
        clientRequestId: randomUUID(),
        batchId: b.batchId,
        scans: b.argon.map(scan),
      },
    });
    expect(ret.statusCode).toBe(400);
  });

  it('refuses something that is not a phone number', async () => {
    const b = await makeBatch({ qty: 1, to: 'SITE' }, { qty: 1, to: 'SITE' });
    for (const bad of ['', 'call me', '12']) {
      const res = await transfer({
        batchId: b.batchId,
        destination: { type: 'STORES' },
        scans: b.argon.map(scan),
        driverPhone: bad,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

// ------------------------------------------------------------------ the emails

describe('the project manager hears about every transfer and return', () => {
  it('a transfer emails the PM the driver’s details, with the cylinder photo', async () => {
    const b = await makeBatch({ qty: 2, to: 'STORES' }, { qty: 1, to: 'STORES' });
    const all = [...b.argon, ...b.nitrogen];
    await initialize(b.batchId, all, [
      { gasTypeId: argonId, cage: 1 },
      { gasTypeId: nitrogenId, cage: 1 },
    ]);
    const res = await transfer({
      batchId: b.batchId,
      destination: { type: 'SITE', siteId },
      scans: all.map(scan),
    });
    expect(res.statusCode).toBe(201);
    const transferId = res.json().transfer.id as string;

    const row = await prisma.outboundEmail.findFirstOrThrow({
      where: { type: 'TRANSFER_NOTICE', payload: { path: ['transferId'], equals: transferId } },
    });
    expect(row.to).toBe(pm.email);
    expect(row.subject).toContain('Durban');
    expect(row.bodyText).toContain('Sipho Ndlovu');
    expect(row.bodyText).toContain(TEST_DRIVER_PHONE);
    expect(row.bodyText).toContain(TEST_DRIVER_EMAIL);
    for (const s of all) expect(row.bodyText).toContain(s);

    clearCapturedMail();
    while ((await processPendingEmails(10)) > 0) {
      /* drain */
    }
    const sent = await prisma.outboundEmail.findUniqueOrThrow({ where: { id: row.id } });
    expect(sent.status).toBe('SENT');
    const mail = capturedMail().find((m) => m.subject === row.subject)!;
    const names = (mail.attachments ?? []).map((a) => a.filename);
    expect(names.some((n) => n.startsWith('cylinders-'))).toBe(true);
    expect(names.some((n) => n.startsWith('driver-id-'))).toBe(false);
  });

  it('the email for a move back to stores says which came back empty and into which cage', async () => {
    const b = await makeBatch({ qty: 2, to: 'STORES' }, { qty: 1, to: 'STORES' });
    await initialize(
      b.batchId,
      [...b.argon, ...b.nitrogen],
      [
        { gasTypeId: argonId, cage: 1 },
        { gasTypeId: nitrogenId, cage: 1 },
      ],
    );
    await transfer({
      batchId: b.batchId,
      destination: { type: 'SITE', siteId },
      scans: b.argon.map(scan),
    });
    const res = await transfer({
      batchId: b.batchId,
      destination: { type: 'STORES' },
      scans: b.argon.map(scan),
      cages: [{ gasTypeId: argonId, cage: 3 }],
      emptySerials: [b.argon[0]!],
    });
    expect(res.statusCode).toBe(201);
    const row = await prisma.outboundEmail.findFirstOrThrow({
      where: { payload: { path: ['transferId'], equals: res.json().transfer.id } },
    });
    expect(row.bodyText).toContain('1 full, 1 empty');
    expect(row.bodyText).toMatch(new RegExp(`${b.argon[0]}.*cage 3, EMPTY`));
  });

  it('a return to the supplier emails the delivery note with the driver phone, and takes cylinders out of their cage', async () => {
    const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'SITE' });
    await initialize(b.batchId, [...b.argon, ...b.nitrogen], [{ gasTypeId: argonId, cage: 2 }]);
    const res = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        ...testSignOff(),
        photo: testPhoto(),
        clientRequestId: randomUUID(),
        batchId: b.batchId,
        scans: b.argon.map(scan),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().returnRecord.driverPhone).toBe(TEST_DRIVER_PHONE);
    expect(await cylinder(b.argon[0]!)).toMatchObject({ status: 'RETURNED', cage: null });

    const row = await prisma.outboundEmail.findFirstOrThrow({
      where: {
        type: 'DELIVERY_NOTE',
        payload: { path: ['returnRecordId'], equals: res.json().returnRecord.id },
      },
    });
    expect(row.bodyText).toContain(TEST_DRIVER_PHONE);
    expect(row.bodyText).toContain('returned to the supplier');
  });
});

// ------------------------------------------------------------- the stores console

describe('GET /stores/summary', () => {
  it('counts every cylinder in rotation by gas, cage and full/empty — and not returned ones', async () => {
    // Fresh state so the counts are exact.
    await resetDb();
    pm = await makeProjectManager('Console PM');
    const created = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber: uniqueProjectNumber(),
        projectManagerId: pm.id,
        clientName: 'Console Client',
        location: 'Midrand',
      },
    });
    projectId = created.json().project.id;
    siteId = created.json().project.sites[0].id;

    // 4 argon into cage 1; 3 nitrogen into cage 2 and then out to site.
    const b = await makeBatch({ qty: 4, to: 'STORES' }, { qty: 3, to: 'STORES' });
    await initialize(
      b.batchId,
      [...b.argon, ...b.nitrogen],
      [
        { gasTypeId: argonId, cage: 1 },
        { gasTypeId: nitrogenId, cage: 2 },
      ],
    );
    await transfer({
      batchId: b.batchId,
      destination: { type: 'SITE', siteId },
      scans: b.nitrogen.map(scan),
    });
    // Bring 2 nitrogen back into cage 3, one of them empty.
    await transfer({
      batchId: b.batchId,
      destination: { type: 'STORES' },
      scans: b.nitrogen.slice(0, 2).map(scan),
      cages: [{ gasTypeId: nitrogenId, cage: 3 }],
      emptySerials: [b.nitrogen[0]!],
    });
    // Return 1 argon to the supplier: it leaves the count entirely.
    await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        ...testSignOff(),
        photo: testPhoto(),
        clientRequestId: randomUUID(),
        batchId: b.batchId,
        scans: [scan(b.argon[0]!)],
      },
    });

    const s = await summary();
    const argon = s.gases.find((g) => g.gasTypeId === argonId)!;
    const nitrogen = s.gases.find((g) => g.gasTypeId === nitrogenId)!;

    expect(argon).toMatchObject({ total: 3, inStores: { full: 3, empty: 0 }, onSite: 0 });
    expect(argon.cages).toEqual([
      { cage: 1, full: 3, empty: 0 },
      { cage: 2, full: 0, empty: 0 },
      { cage: 3, full: 0, empty: 0 },
    ]);
    expect(nitrogen).toMatchObject({ total: 3, inStores: { full: 1, empty: 1 }, onSite: 1 });
    expect(nitrogen.cages[2]).toEqual({ cage: 3, full: 1, empty: 1 });
    expect(s.totals).toMatchObject({ total: 6, inStores: { full: 4, empty: 1 }, onSite: 1 });
  });

  it('counts cylinders in stores from before cages as "no cage"', async () => {
    const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'SITE' });
    await prisma.cylinder.updateMany({ where: { batchId: b.batchId }, data: { cage: null } });
    const argon = (await summary()).gases.find((g) => g.gasTypeId === argonId)!;
    expect(argon.noCage.full).toBeGreaterThanOrEqual(1);
  });

  it('is open to stores managers and project managers, not technicians', async () => {
    await summary(storesToken);
    await summary(await loginAs(app, DEMO.admin));
    const res = await app.inject({
      method: 'GET',
      url: '/stores/summary',
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------- copies to the stores manager

describe('the stores manager is copied on every event', () => {
  const copiesFor = (where: object) =>
    prisma.outboundEmail.findMany({ where: { ...where, to: DEMO.stores } });

  it('gets the QR sheet of a new batch, a transfer notice and a delivery note', async () => {
    const b = await makeBatch({ qty: 2, to: 'STORES' }, { qty: 1, to: 'STORES' });
    const [qr] = await copiesFor({
      type: 'QR_SHEET',
      payload: { path: ['batchId'], equals: b.batchId },
    });
    expect(qr).toBeTruthy();
    expect((qr!.payload as { copy?: string }).copy).toBe('stores');

    await initialize(
      b.batchId,
      [...b.argon, ...b.nitrogen],
      [
        { gasTypeId: argonId, cage: 1 },
        { gasTypeId: nitrogenId, cage: 2 },
      ],
    );
    const t = await transfer({
      batchId: b.batchId,
      destination: { type: 'SITE', siteId },
      scans: b.argon.map(scan),
    });
    const transferId = t.json().transfer.id as string;
    const notices = await copiesFor({
      type: 'TRANSFER_NOTICE',
      payload: { path: ['transferId'], equals: transferId },
    });
    expect(notices).toHaveLength(1);
    // Same email as the project manager's — not a summary of it.
    const pmNotice = await prisma.outboundEmail.findFirstOrThrow({
      where: {
        type: 'TRANSFER_NOTICE',
        to: pm.email,
        payload: { path: ['transferId'], equals: transferId },
      },
    });
    expect(notices[0]!.bodyText).toBe(pmNotice.bodyText);

    const r = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        ...testSignOff(),
        photo: testPhoto(),
        clientRequestId: randomUUID(),
        batchId: b.batchId,
        scans: b.nitrogen.map(scan),
      },
    });
    expect(r.statusCode).toBe(201);
    const notes = await copiesFor({
      type: 'DELIVERY_NOTE',
      payload: { path: ['returnRecordId'], equals: r.json().returnRecord.id },
    });
    expect(notes).toHaveLength(1);

    // The copy carries the same attachments when it is sent.
    clearCapturedMail();
    while ((await processPendingEmails(20)) > 0) {
      /* drain */
    }
    const sentCopy = capturedMail().find(
      (m) => m.to === DEMO.stores && m.subject === notes[0]!.subject,
    );
    expect(sentCopy?.attachments?.some((a) => a.filename.startsWith('delivery-note'))).toBe(true);
  });

  it('a deactivated stores manager is not copied', async () => {
    await prisma.user.updateMany({ where: { email: DEMO.stores }, data: { active: false } });
    try {
      const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'STORES' });
      expect(
        await copiesFor({ type: 'QR_SHEET', payload: { path: ['batchId'], equals: b.batchId } }),
      ).toHaveLength(0);
    } finally {
      await prisma.user.updateMany({ where: { email: DEMO.stores }, data: { active: true } });
    }
  });

  it("the batch screen's email status still reports the project manager's QR sheet", async () => {
    const b = await makeBatch({ qty: 1, to: 'STORES' }, { qty: 1, to: 'STORES' });
    const res = await app.inject({
      method: 'GET',
      url: `/batches/${b.batchId}`,
      headers: bearer(techToken),
    });
    expect(res.json().emailDelivery.to).toBe(pm.email);
  });
});
