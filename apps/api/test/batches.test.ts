import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
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
let storesToken: string;
let projectId: string;
let siteId: string;
let nitrogenId: string;
let supplierId: string;
let argonId: string;
let pmEmail: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);

  const pm = await makeProjectManager('Batch PM');
  pmEmail = pm.email;
  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: pm.id,
      site: { name: 'Batch Yard', location: 'JHB' },
    },
  });
  projectId = created.json().project.id;
  siteId = created.json().project.sites[0].id;

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  // The seed pairs both suppliers with both gases, so one id serves every line here.
  supplierId = await supplierForGas(nitrogenId);
  argonId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Argon').id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const createBatch = (payload: Record<string, unknown>, token = techToken) =>
  app.inject({ method: 'POST', url: '/batches', headers: bearer(token), payload });

describe('POST /batches', () => {
  it('allocates serials, creates cylinders + INTAKE events, queues a QR email', async () => {
    const res = await createBatch({
      projectId,
      siteId,
      clientRequestId: randomUUID(),
      lines: [
        {
          gasTypeId: nitrogenId,
          supplierId,
          quantity: 5,
          initialDeliveryPoint: 'STORES',
        },
      ],
    });
    expect(res.statusCode).toBe(201);
    const { batch, serials } = res.json();

    expect(serials).toHaveLength(5);
    for (const s of serials) expect(s).toMatch(/^NIT\d{2}-\d{3,}$/);
    expect(batch.cylinders).toHaveLength(5);
    expect(batch.cylinders.every((c: { status: string }) => c.status === 'IN_STORES')).toBe(true);
    expect(batch.lines[0].gasTypeName).toBe('Nitrogen');
    expect(batch.status).toBe('ACTIVE');

    const events = await prisma.movementEvent.count({
      where: { cylinder: { batchId: batch.id }, type: 'INTAKE' },
    });
    expect(events).toBe(5);

    const email = await prisma.outboundEmail.findFirst({
      where: { type: 'QR_SHEET', payload: { path: ['batchId'], equals: batch.id } },
    });
    expect(email).not.toBeNull();
    // Addressed from the batch's own snapshot, which must equal the manager's address
    // at creation — that snapshot is what a resend re-uses months later.
    expect(email?.to).toBe(pmEmail);
    expect(res.json().batch.projectManagerEmail).toBe(pmEmail);
    expect(email?.status).toBe('PENDING');
  });

  it('is idempotent on clientRequestId (replay returns the same batch, 200)', async () => {
    const clientRequestId = randomUUID();
    const body = {
      projectId,
      siteId,
      clientRequestId,
      lines: [
        {
          gasTypeId: argonId,
          supplierId,
          quantity: 3,
          initialDeliveryPoint: 'STORES',
        },
      ],
    };
    const first = await createBatch(body);
    expect(first.statusCode).toBe(201);

    const replay = await createBatch(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().batch.id).toBe(first.json().batch.id);
    expect(replay.json().serials).toEqual(first.json().serials);

    const count = await prisma.batch.count({ where: { clientRequestId } });
    expect(count).toBe(1);
  });

  it('rejects a site from another project (400)', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber: uniqueProjectNumber(),
        projectManagerId: (await makeProjectManager('Other')).id,
        site: { name: 'Elsewhere', location: 'X' },
      },
    });
    const otherSiteId = other.json().project.sites[0].id;

    const res = await createBatch({
      projectId,
      siteId: otherSiteId,
      clientRequestId: randomUUID(),
      lines: [{ gasTypeId: nitrogenId, supplierId, quantity: 1, initialDeliveryPoint: 'STORES' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_SITE');
  });

  it('rejects an unknown gas type (400) and a bad quantity (400)', async () => {
    const badGas = await createBatch({
      projectId,
      siteId,
      clientRequestId: randomUUID(),
      lines: [{ gasTypeId: 'nope', supplierId, quantity: 1, initialDeliveryPoint: 'STORES' }],
    });
    expect(badGas.statusCode).toBe(400);
    expect(badGas.json().error.code).toBe('INVALID_GAS_TYPE');

    const badQty = await createBatch({
      projectId,
      siteId,
      clientRequestId: randomUUID(),
      lines: [{ gasTypeId: nitrogenId, supplierId, quantity: 0, initialDeliveryPoint: 'STORES' }],
    });
    expect(badQty.statusCode).toBe(400);
    expect(badQty.json().error.code).toBe('VALIDATION');
  });

  it('403s for a stores manager', async () => {
    const res = await createBatch(
      {
        projectId,
        siteId,
        clientRequestId: randomUUID(),
        lines: [{ gasTypeId: nitrogenId, supplierId, quantity: 1, initialDeliveryPoint: 'STORES' }],
      },
      storesToken,
    );
    expect(res.statusCode).toBe(403);
  });

  it('20 concurrent POST /batches on one gas type -> all serials globally unique', async () => {
    const concProject = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber: uniqueProjectNumber(),
        projectManagerId: (await makeProjectManager('Conc PM')).id,
        site: { name: 'Conc Yard', location: 'X' },
      },
    });
    const cpId = concProject.json().project.id;
    const csId = concProject.json().project.sites[0].id;

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        createBatch({
          projectId: cpId,
          siteId: csId,
          clientRequestId: randomUUID(),
          lines: [
            {
              gasTypeId: nitrogenId,
              supplierId,
              quantity: 5,
              initialDeliveryPoint: 'STORES',
            },
          ],
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);

    const serials = results.flatMap((r) => r.json().serials as string[]);
    expect(serials).toHaveLength(100);
    expect(new Set(serials).size).toBe(100); // globally unique across all 20 concurrent calls
  });
});

describe('GET /batches', () => {
  it('lists batches for a project with cylinder/returned counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/batches?projectId=${projectId}&status=active`,
      headers: bearer(techToken),
    });
    expect(res.statusCode).toBe(200);
    const batches = res.json().batches;
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) {
      expect(b.status).not.toBe('RETURNED');
      expect(b.cylinderCount).toBe(b.quantity);
      expect(b.returnedCount).toBe(0);
      expect(b).not.toHaveProperty('cylinders');
    }
  });
});

describe('GET /batches/:id', () => {
  it('returns the full batch with cylinders; 404 for unknown', async () => {
    const created = await createBatch({
      projectId,
      siteId,
      clientRequestId: randomUUID(),
      lines: [{ gasTypeId: nitrogenId, supplierId, quantity: 2, initialDeliveryPoint: 'STORES' }],
    });
    const id = created.json().batch.id;

    const ok = await app.inject({
      method: 'GET',
      url: `/batches/${id}`,
      headers: bearer(techToken),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().batch.cylinders).toHaveLength(2);

    const missing = await app.inject({
      method: 'GET',
      url: '/batches/nope',
      headers: bearer(techToken),
    });
    expect(missing.statusCode).toBe(404);
  });
});
