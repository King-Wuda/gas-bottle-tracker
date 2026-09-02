/**
 * The website change spec: catalogue endpoints, the supplier/gas pairing, the delivery
 * point enum, the manager-email snapshot, the tab-scoped batch list, and the 60-second
 * resend lock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { RESEND_LOCKOUT_SECONDS, type ScanInput } from '@gct/shared';
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
  testPhoto,
  uniqueProjectNumber,
} from './helpers.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SIGNATURE = `data:image/png;base64,${PNG_1X1}`;

let app: FastifyInstance;
let techToken: string;
let storesToken: string;

let nitrogenId: string;
let argonId: string;
let supplier1: string;
let supplier2: string;

/** Two projects with different managers, so the PM filter has something to separate. */
let projectA: string;
let siteA: string;
let numberA: string;
let pmA: { id: string; email: string };

let projectB: string;
let siteB: string;
let numberB: string;
let pmB: { id: string; email: string };

const createProject = async (managerName: string) => {
  const pm = await makeProjectManager(managerName);
  const projectNumber = uniqueProjectNumber();
  const res = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber,
      projectManagerId: pm.id,
      site: { name: `Yard ${managerName}`, location: 'JHB' },
    },
  });
  if (res.statusCode !== 201) throw new Error(`createProject: ${res.statusCode} ${res.body}`);
  return {
    pm,
    projectNumber,
    projectId: res.json().project.id as string,
    siteId: res.json().project.sites[0].id as string,
  };
};

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  argonId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Argon').id;

  const sup = await app.inject({ method: 'GET', url: '/suppliers', headers: bearer(techToken) });
  supplier1 = sup.json().suppliers.find((s: { name: string }) => s.name === 'Supplier 1').id;
  supplier2 = sup.json().suppliers.find((s: { name: string }) => s.name === 'Supplier 2').id;

  const a = await createProject('Alpha Manager');
  ({ projectId: projectA, siteId: siteA, projectNumber: numberA, pm: pmA } = a);
  const b = await createProject('Beta Manager');
  ({ projectId: projectB, siteId: siteB, projectNumber: numberB, pm: pmB } = b);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function makeBatch(opts: {
  projectId: string;
  siteId: string;
  gasTypeId?: string;
  supplierId?: string;
  quantity?: number;
  deliveryPoint?: string;
  /**
   * Scan the batch in, which every batch needs before it can be transferred or
   * returned. Defaults to true because the section-8/9 list assertions below are
   * about scope and filters, not about the initialization gate; the tests that ARE
   * about the gate live in initializations.test.ts and opt out here.
   */
  initialize?: boolean;
}): Promise<{ batchId: string; serials: string[]; batch: Record<string, unknown> }> {
  const res = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: {
      projectId: opts.projectId,
      siteId: opts.siteId,
      clientRequestId: randomUUID(),
      lines: [
        {
          gasTypeId: opts.gasTypeId ?? nitrogenId,
          supplierId: opts.supplierId ?? supplier1,
          quantity: opts.quantity ?? 2,
          initialDeliveryPoint: opts.deliveryPoint ?? 'STORES',
        },
      ],
    },
  });
  if (res.statusCode !== 201) throw new Error(`makeBatch: ${res.statusCode} ${res.body}`);
  const batchId = res.json().batch.id as string;
  const serials = res.json().serials as string[];
  if (opts.initialize !== false) await initializeBatch(app, techToken, batchId, serials);
  return { batchId, serials, batch: res.json().batch };
}

const scan = (serialCode: string): ScanInput => ({
  serialCode,
  qrPayload: qrPayloadFor(serialCode),
  scannedAt: new Date().toISOString(),
});

const listBatches = (query: string, token = techToken) =>
  app.inject({ method: 'GET', url: `/batches?${query}`, headers: bearer(token) });

// ----------------------------------------------------------------- section 2, 3, 4

describe('catalogue endpoints', () => {
  it('GET /project-managers lists the stored managers, so the dropdown is data-driven', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/project-managers',
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(200);
    const emails = res.json().projectManagers.map((m: { email: string }) => m.email);
    expect(emails).toEqual(expect.arrayContaining([pmA.email, pmB.email]));
    // Data-driven, not a hardcoded list: the endpoint returns exactly what the table
    // holds, so adding a manager really is an INSERT and nothing else.
    const stored = await prisma.projectManager.findMany({ orderBy: { name: 'asc' } });
    expect(emails).toEqual(stored.map((m) => m.email));
    for (const m of res.json().projectManagers) {
      expect(m).toHaveProperty('id');
      expect(m).toHaveProperty('name');
      expect(m.email).toMatch(/@/);
    }
  });

  it('GET /suppliers narrows to the suppliers paired with a gas', async () => {
    const all = await app.inject({ method: 'GET', url: '/suppliers', headers: bearer(techToken) });
    expect(all.json().suppliers.map((s: { name: string }) => s.name)).toEqual(
      expect.arrayContaining(['Supplier 1', 'Supplier 2']),
    );

    for (const gasTypeId of [nitrogenId, argonId]) {
      const res = await app.inject({
        method: 'GET',
        url: `/suppliers?gasTypeId=${gasTypeId}`,
        headers: bearer(techToken),
      });
      expect(res.statusCode).toBe(200);
      const returned = res
        .json()
        .suppliers.map((s: { id: string }) => s.id)
        .sort();
      // The seeded pair must be there, and the result must be exactly the GasSupplier
      // rows for this gas — not "every supplier", which is the bug worth catching.
      expect(returned).toEqual(expect.arrayContaining([supplier1, supplier2]));
      const paired = await prisma.gasSupplier.findMany({
        where: { gasTypeId, supplier: { active: true } },
      });
      expect(returned).toEqual(paired.map((p) => p.supplierId).sort());
    }
  });

  it('GET /suppliers returns nothing for a gas with no pairings', async () => {
    // Proves the pairing is actually consulted rather than the endpoint always
    // returning every supplier — Oxygen is seeded but deliberately unpaired.
    const oxygen = await prisma.gasType.findUniqueOrThrow({ where: { name: 'Oxygen' } });
    const res = await app.inject({
      method: 'GET',
      url: `/suppliers?gasTypeId=${oxygen.id}`,
      headers: bearer(techToken),
    });
    expect(res.json().suppliers).toEqual([]);
  });

  it('GET /sites lists each distinct site name once, with its latest location', async () => {
    // Same name on two projects, recorded with different locations: the newer wins.
    await app.inject({
      method: 'POST',
      url: `/projects/${projectA}/sites`,
      headers: bearer(techToken),
      payload: { name: 'Shared Depot', location: 'Old Town' },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${projectB}/sites`,
      headers: bearer(techToken),
      payload: { name: 'Shared Depot', location: 'New Town' },
    });

    const res = await app.inject({ method: 'GET', url: '/sites', headers: bearer(techToken) });
    expect(res.statusCode).toBe(200);
    const shared = res.json().sites.filter((s: { name: string }) => s.name === 'Shared Depot');
    expect(shared).toHaveLength(1);
    expect(shared[0].location).toBe('New Town');
  });
});

// ----------------------------------------------------------------- section 4, 5, 6

describe('POST /batches — supplier pairing, delivery point, snapshots', () => {
  it('rejects a supplier that does not stock the chosen gas', async () => {
    const oxygen = await prisma.gasType.findUniqueOrThrow({ where: { name: 'Oxygen' } });
    // Oxygen is inactive, so it fails earlier — use a supplier unpaired with Nitrogen.
    const orphan = await prisma.supplier.create({ data: { name: `Orphan ${Date.now()}` } });
    const res = await app.inject({
      method: 'POST',
      url: '/batches',
      headers: bearer(techToken),
      payload: {
        projectId: projectA,
        siteId: siteA,
        clientRequestId: randomUUID(),
        lines: [
          {
            gasTypeId: nitrogenId,
            supplierId: orphan.id,
            quantity: 1,
            initialDeliveryPoint: 'STORES',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SUPPLIER');
    expect(oxygen.active).toBe(false);
  });

  it('rejects a free-text initial delivery point', async () => {
    for (const bad of ['Gate 1', 'stores', 'Site B', '']) {
      const res = await app.inject({
        method: 'POST',
        url: '/batches',
        headers: bearer(techToken),
        payload: {
          projectId: projectA,
          siteId: siteA,
          clientRequestId: randomUUID(),
          lines: [
            {
              gasTypeId: nitrogenId,
              supplierId: supplier1,
              quantity: 1,
              initialDeliveryPoint: bad,
            },
          ],
        },
      });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });

  it('refuses a bad delivery point at the database too', async () => {
    // The CHECK constraint is the backstop for anything reaching Postgres without
    // passing through zod — a script, a migration, psql.
    const { batchId } = await makeBatch({ projectId: projectA, siteId: siteA });
    await expect(
      prisma.batch.update({
        where: { id: batchId },
        data: { initialDeliveryPoint: 'Gate 1' },
      }),
    ).rejects.toThrow();
  });

  it('snapshots the supplier name and the manager email, and stamps createdAt', async () => {
    const created = await makeBatch({
      projectId: projectA,
      siteId: siteA,
      supplierId: supplier2,
      deliveryPoint: 'SITE',
    });
    const batch = created.batch as Record<string, string | number | null>;
    // Gas, supplier, quantity and delivery point live on the batch's LINES now — a
    // batch is a delivery, and a delivery can carry several gases from several
    // suppliers.
    const lines = created.batch.lines as Record<string, string | number | null>[];

    expect(lines).toHaveLength(1);
    expect(lines[0]!.supplierId).toBe(supplier2);
    expect(lines[0]!.supplierName).toBe('Supplier 2');
    expect(lines[0]!.initialDeliveryPoint).toBe('SITE');
    expect(batch.projectManagerEmail).toBe(pmA.email);
    expect(batch.projectNumber).toBe(numberA);
    expect(batch.siteName).toBe('Yard Alpha Manager');

    // Set by the database default, not the caller: within a few seconds of now.
    const createdAt = new Date(batch.createdAt as string);
    expect(Math.abs(Date.now() - createdAt.getTime())).toBeLessThan(30_000);

    // The confirmation screen opens with the resend already locked.
    expect(batch.emailSentAt).not.toBeNull();
    expect(batch.lastEmailSentAt).not.toBeNull();
    expect(batch.resendCount).toBe(0);
    expect(batch.transferredAt).toBeNull();
    expect(batch.returnedAt).toBeNull();
  });

  it('renaming the supplier does not rewrite paperwork already issued', async () => {
    // Supplier rows outlive resetDb (batches reference them), so both names have to be
    // unique across runs, not just within one.
    const stamp = `${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
    const renamed = await prisma.supplier.create({ data: { name: `Before ${stamp}` } });
    await prisma.gasSupplier.create({ data: { gasTypeId: nitrogenId, supplierId: renamed.id } });
    const { batchId } = await makeBatch({
      projectId: projectA,
      siteId: siteA,
      supplierId: renamed.id,
    });

    await prisma.supplier.update({
      where: { id: renamed.id },
      data: { name: `After ${stamp}` },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/batches/${batchId}`,
      headers: bearer(techToken),
    });
    expect(res.json().batch.lines[0].supplierName).toMatch(/^Before /);
  });
});

// ----------------------------------------------------------------- sections 8, 9, 10

describe('GET /batches — the shared Transfer / Returns / History list', () => {
  let transferred: string;
  let returned: string;
  let untouched: string;

  beforeAll(async () => {
    // One batch that gets transferred, one that gets fully returned, one left alone.
    const t = await makeBatch({ projectId: projectB, siteId: siteB, quantity: 2 });
    transferred = t.batchId;
    const moved = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId: transferred,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId: siteB },
        scans: t.serials.map(scan),
      },
    });
    expect(moved.statusCode).toBe(201);

    const r = await makeBatch({ projectId: projectB, siteId: siteB, quantity: 2 });
    returned = r.batchId;
    const back = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        photo: testPhoto(),
        batchId: returned,
        clientRequestId: randomUUID(),
        driverName: 'Driver D',
        signaturePng: SIGNATURE,
        scans: r.serials.map(scan),
      },
    });
    expect(back.statusCode).toBe(201);

    untouched = (await makeBatch({ projectId: projectA, siteId: siteA })).batchId;
  });

  const ids = (res: Awaited<ReturnType<typeof listBatches>>): string[] =>
    res.json().batches.map((b: { id: string }) => b.id);

  it('stamps transferredAt on the first transfer and returnedAt on the last return', async () => {
    const t = await prisma.batch.findUniqueOrThrow({ where: { id: transferred } });
    expect(t.transferredAt).not.toBeNull();
    expect(t.returnedAt).toBeNull();

    const r = await prisma.batch.findUniqueOrThrow({ where: { id: returned } });
    expect(r.returnedAt).not.toBeNull();
    expect(r.status).toBe('RETURNED');
  });

  it('a partial return does not stamp returnedAt — the batch is still outstanding', async () => {
    const p = await makeBatch({ projectId: projectA, siteId: siteA, quantity: 3 });
    const res = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        photo: testPhoto(),
        batchId: p.batchId,
        clientRequestId: randomUUID(),
        driverName: 'Driver P',
        signaturePng: SIGNATURE,
        scans: [scan(p.serials[0]!)],
      },
    });
    expect(res.statusCode).toBe(201);
    const row = await prisma.batch.findUniqueOrThrow({ where: { id: p.batchId } });
    expect(row.status).toBe('PARTIAL');
    expect(row.returnedAt).toBeNull();
  });

  it('a second transfer does not overwrite the first transfer stamp', async () => {
    const t = await prisma.batch.findUniqueOrThrow({ where: { id: transferred } });
    const first = t.transferredAt;

    const again = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId: transferred,
        clientRequestId: randomUUID(),
        destination: { type: 'STORES' },
        scans: (await prisma.cylinder.findMany({ where: { batchId: transferred } })).map((c) =>
          scan(c.serialCode),
        ),
      },
    });
    expect(again.statusCode).toBe(201);

    const after = await prisma.batch.findUniqueOrThrow({ where: { id: transferred } });
    expect(after.transferredAt?.toISOString()).toBe(first?.toISOString());
  });

  it('Transfer keeps a batch that has already moved — it can always move again', async () => {
    // The old behaviour hid `transferred` here and offered a toggle to bring it back.
    // That assumed a batch moves once, all at once. It does not: a partial transfer
    // leaves cylinders behind that still need moving, and cylinders already on site
    // still need moving to the next site or back to stores.
    const list = await listBatches('scope=transfer&status=active');
    expect(ids(list)).toContain(transferred);
    expect(ids(list)).toContain(untouched);
  });

  it('Transfer still drops a fully-returned batch — a returned cylinder cannot move', async () => {
    const list = await listBatches('scope=transfer&status=active');
    expect(ids(list)).not.toContain(returned);
  });

  it('Returns drops a fully-returned batch but keeps one with cylinders still out', async () => {
    const list = await listBatches('scope=returns&status=active');
    expect(ids(list)).not.toContain(returned);
    // Transferred, not returned: its cylinders are on site and still have to come back.
    expect(ids(list)).toContain(transferred);
  });

  it('reports where each gas in a batch actually is, per location', async () => {
    // The fact the movement tabs exist to show: of the cylinders booked in together,
    // which are at stores and which went out.
    const split = await makeBatch({ projectId: projectB, siteId: siteB, quantity: 3 });
    const moveOne = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId: split.batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId: siteB },
        scans: [scan(split.serials[0]!)],
      },
    });
    expect(moveOne.statusCode).toBe(201);

    const res = await listBatches('scope=transfer&status=active');
    const row = res.json().batches.find((b: { id: string }) => b.id === split.batchId) as {
      distribution: { kind: string; count: number; locationName: string }[];
    };

    const atStores = row.distribution.find((d) => d.kind === 'STORES');
    const onSite = row.distribution.find((d) => d.kind === 'SITE');
    expect(atStores?.count).toBe(2);
    expect(onSite?.count).toBe(1);
    expect(onSite?.locationName).toBe('Yard Beta Manager');
  });

  it('History excludes nothing and comes back newest-first', async () => {
    const res = await listBatches('scope=history&status=all');
    const rows = ids(res);
    expect(rows).toEqual(expect.arrayContaining([transferred, returned, untouched]));

    const created = res.json().batches.map((b: { createdAt: string }) => Date.parse(b.createdAt));
    const sorted = [...created].sort((a, b) => b - a);
    expect(created).toEqual(sorted);
  });

  it('sorting survives filtering — a filtered History page is still newest-first', async () => {
    const res = await listBatches(
      `scope=history&status=all&projectManagerId=${encodeURIComponent(pmB.id)}`,
    );
    const created = res.json().batches.map((b: { createdAt: string }) => Date.parse(b.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));
    expect(created.length).toBeGreaterThan(1);
  });

  it('searches project number AND project manager name, case-insensitively, mid-string', async () => {
    const byNumber = await listBatches(
      `scope=history&status=all&q=${encodeURIComponent(numberB.slice(3, 10))}`,
    );
    expect(byNumber.json().batches.length).toBeGreaterThan(0);
    for (const b of byNumber.json().batches) expect(b.projectNumber).toBe(numberB);

    // Substring from the middle of the name, wrong case: "eta manag" -> Beta Manager.
    const byManager = await listBatches('scope=history&status=all&q=eta%20manag');
    expect(byManager.json().batches.length).toBeGreaterThan(0);
    for (const b of byManager.json().batches) expect(b.projectManagerName).toBe('Beta Manager');
  });

  it('combines filters with AND, not OR', async () => {
    // A manager who has batches and a supplier that manager never used: an OR would
    // return rows; AND must return none.
    const lonely = await prisma.supplier.create({ data: { name: `Lonely ${Date.now()}` } });
    const res = await listBatches(
      `scope=history&status=all&projectManagerId=${pmB.id}&supplierId=${lonely.id}`,
    );
    expect(res.json().batches).toEqual([]);
    expect(res.json().matched).toBe(0);
  });

  it('filters by supplier and by gas', async () => {
    const argonBatch = await makeBatch({
      projectId: projectA,
      siteId: siteA,
      gasTypeId: argonId,
      supplierId: supplier2,
    });

    // Gas and supplier are properties of a LINE now, so these filters ask "does any
    // line match?" — a mixed batch containing argon is an argon result.
    type Row = { lines: { gasTypeName: string; supplierName: string }[] };

    const byGas = await listBatches(`scope=history&status=all&gasTypeId=${argonId}`);
    expect(ids(byGas)).toContain(argonBatch.batchId);
    for (const b of byGas.json().batches as Row[]) {
      expect(b.lines.some((l) => l.gasTypeName === 'Argon')).toBe(true);
    }

    const bySupplier = await listBatches(`scope=history&status=all&supplierId=${supplier2}`);
    for (const b of bySupplier.json().batches as Row[]) {
      expect(b.lines.some((l) => l.supplierName === 'Supplier 2')).toBe(true);
    }
  });

  it('reports matched-of-total so the UI can say "12 of 48"', async () => {
    const all = await listBatches('scope=history&status=all');
    const filtered = await listBatches(`scope=history&status=all&projectManagerId=${pmA.id}`);

    expect(filtered.json().total).toBe(all.json().total);
    expect(filtered.json().matched).toBeLessThan(all.json().matched);
    expect(filtered.json().matched).toBe(filtered.json().batches.length);
  });

  it('carries every column the row renders', async () => {
    const res = await listBatches('scope=history&status=all');
    const row = res.json().batches[0];
    for (const key of [
      'projectNumber',
      'projectManagerName',
      'siteName',
      'siteLocation',
      'quantity',
      'createdAt',
      'transferredAt',
      'returnedAt',
      // What the row shows instead of a single gas/supplier: the batch's lines, and
      // where each gas in it currently is.
      'lines',
      'distribution',
    ]) {
      expect(row, key).toHaveProperty(key);
    }
    for (const key of ['gasTypeName', 'supplierName', 'quantity', 'initialDeliveryPoint']) {
      expect(row.lines[0], key).toHaveProperty(key);
    }
  });

  it('creates ONE batch from several lines, with serials allocated per gas', async () => {
    // The multi-gas case end to end: two gases on one delivery is one batch, and each
    // line's serials carry its own gas prefix.
    const res = await app.inject({
      method: 'POST',
      url: '/batches',
      headers: bearer(techToken),
      payload: {
        projectId: projectA,
        siteId: siteA,
        clientRequestId: randomUUID(),
        lines: [
          {
            gasTypeId: nitrogenId,
            supplierId: supplier1,
            quantity: 3,
            initialDeliveryPoint: 'STORES',
          },
          { gasTypeId: argonId, supplierId: supplier2, quantity: 2, initialDeliveryPoint: 'SITE' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);

    const batch = res.json().batch;
    expect(batch.lines).toHaveLength(2);
    expect(batch.quantity).toBe(5);
    expect(batch.cylinders).toHaveLength(5);

    const serials: string[] = res.json().serials;
    expect(serials.filter((x) => x.startsWith('NIT'))).toHaveLength(3);
    expect(serials.filter((x) => x.startsWith('ARG'))).toHaveLength(2);

    // Each cylinder points at the line it was booked in under, so the per-gas
    // breakdown has something to group by.
    const lineIds = new Set(batch.lines.map((l: { id: string }) => l.id));
    for (const c of batch.cylinders) expect(lineIds.has(c.batchLineId)).toBe(true);

    // One batch means one QR sheet, not one per gas.
    const emails = await prisma.outboundEmail.findMany({
      where: { type: 'QR_SHEET', payload: { path: ['batchId'], equals: batch.id } },
    });
    expect(emails).toHaveLength(1);
  });

  it('writes the batch whole or not at all — a bad line creates nothing', async () => {
    const before = await prisma.batch.count();
    const res = await app.inject({
      method: 'POST',
      url: '/batches',
      headers: bearer(techToken),
      payload: {
        projectId: projectA,
        siteId: siteA,
        clientRequestId: randomUUID(),
        lines: [
          {
            gasTypeId: nitrogenId,
            supplierId: supplier1,
            quantity: 2,
            initialDeliveryPoint: 'STORES',
          },
          // supplier2 does not stock this gas pairing in the seed for argon? It does —
          // so use an id that cannot resolve at all.
          {
            gasTypeId: argonId,
            supplierId: 'not-a-supplier',
            quantity: 2,
            initialDeliveryPoint: 'STORES',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    // No half-created batch, and no serials burned on the line that was fine.
    expect(await prisma.batch.count()).toBe(before);
  });

  it('rejects an unrecognised scope rather than silently answering a different question', async () => {
    const res = await listBatches('scope=transfres&status=all');
    expect(res.statusCode).toBe(400);
  });
});

// ----------------------------------------------------------------- section 7

describe('POST /batches/:id/resend-email', () => {
  /** Move the batch's lock into the past, the way 60 real seconds would. */
  const openTheWindow = (batchId: string) =>
    prisma.batch.update({
      where: { id: batchId },
      data: { lastEmailSentAt: new Date(Date.now() - (RESEND_LOCKOUT_SECONDS + 5) * 1000) },
    });

  it('refuses with 429 while the lock is still running, and says how long is left', async () => {
    const { batchId } = await makeBatch({ projectId: projectA, siteId: siteA });
    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batchId}/resend-email`,
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RESEND_TOO_SOON');
    const retry = res.json().error.details.retryAfterSeconds;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(RESEND_LOCKOUT_SECONDS);
    expect(res.headers['retry-after']).toBe(String(retry));

    // Refused means refused: no extra mail was queued.
    const queued = await prisma.outboundEmail.count({
      where: { type: 'QR_SHEET', payload: { path: ['batchId'], equals: batchId } },
    });
    expect(queued).toBe(1);
  });

  it('resends once the window has passed, queues the mail, and restarts the lock', async () => {
    const { batchId } = await makeBatch({ projectId: projectA, siteId: siteA });
    await openTheWindow(batchId);

    const res = await app.inject({
      method: 'POST',
      url: `/batches/${batchId}/resend-email`,
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().resendCount).toBe(1);
    expect(res.json().retryAfterSeconds).toBe(RESEND_LOCKOUT_SECONDS);

    const mail = await prisma.outboundEmail.findMany({
      where: { type: 'QR_SHEET', payload: { path: ['batchId'], equals: batchId } },
      orderBy: { createdAt: 'asc' },
    });
    expect(mail).toHaveLength(2);
    // Addressed from the snapshot, and marked so the recipient can tell them apart.
    expect(mail[1]!.to).toBe(pmA.email);
    expect(mail[1]!.subject).toMatch(/^\[Resent\]/);

    // And the lock is closed again.
    const again = await app.inject({
      method: 'POST',
      url: `/batches/${batchId}/resend-email`,
      headers: bearer(techToken),
    });
    expect(again.statusCode).toBe(429);
  });

  it('two simultaneous taps produce one mail, not two', async () => {
    // The lock is claimed in the UPDATE's WHERE clause, so the loser matches zero rows
    // rather than re-reading a value the winner has already moved.
    const { batchId } = await makeBatch({ projectId: projectA, siteId: siteA });
    await openTheWindow(batchId);

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/batches/${batchId}/resend-email`,
        headers: bearer(techToken),
      }),
      app.inject({
        method: 'POST',
        url: `/batches/${batchId}/resend-email`,
        headers: bearer(techToken),
      }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([202, 429]);

    const mail = await prisma.outboundEmail.count({
      where: { type: 'QR_SHEET', payload: { path: ['batchId'], equals: batchId } },
    });
    expect(mail).toBe(2); // the original plus exactly one resend

    const row = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(row.resendCount).toBe(1);
  });

  it('404s for an unknown batch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/batches/does-not-exist/resend-email',
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it('401s without a token', async () => {
    const { batchId } = await makeBatch({ projectId: projectA, siteId: siteA });
    const res = await app.inject({ method: 'POST', url: `/batches/${batchId}/resend-email` });
    expect(res.statusCode).toBe(401);
  });
});
