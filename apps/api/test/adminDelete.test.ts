import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
  testSignOff,
  uniqueProjectNumber,
} from './helpers.js';

/**
 * The destructive admin deletes.
 *
 * Worth testing more carefully than anything else in the console, for the obvious
 * reason: every other route can be undone by typing the value back in. These cannot,
 * and the failure mode of getting the cascade order wrong is not a crash — it is a
 * Restrict violation at the twentieth statement, leaving the caller to wonder whether
 * the first nineteen applied.
 *
 * So the assertions are deliberately about the DATABASE afterwards, table by table,
 * rather than about the HTTP status. A 200 from a delete that silently left forty
 * movement events behind is the bug this file exists to catch.
 */

let app: FastifyInstance;
let adminToken: string;
let techToken: string;
let storesToken: string;
let nitrogenId: string;

/**
 * Long enough for `passwordSchema`, which the seed's own password is not — `loginAs`
 * knows only DEMO_PASSWORD, so accounts created here sign in through `loginWith`.
 */
const TEST_PASSWORD = 'a-long-enough-password';

async function loginWith(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 200)
    throw new Error(`login(${email}) failed: ${res.statusCode} ${res.body}`);
  return res.json().accessToken as string;
}

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();
  adminToken = await loginAs(app, DEMO.admin);
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(techToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/**
 * A gas prefix nothing has claimed yet.
 *
 * `GasType.prefix` is unique for good reason — two gases sharing it would issue
 * serials that collide on a physical label — and `resetDb()` deliberately leaves the
 * reference data alone, so a hard-coded "HE" passes once and 409s on every later run.
 */
async function unusedPrefix(): Promise<string> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 200; attempt++) {
    const prefix = Array.from(
      { length: 3 },
      () => letters[Math.floor(Math.random() * letters.length)]!,
    ).join('');
    if (!(await prisma.gasType.findUnique({ where: { prefix } }))) return prefix;
  }
  throw new Error('could not find an unused gas prefix');
}

/** A gas name nothing has claimed yet — unique for the same reason as the prefix. */
const unusedGasName = (): string => `Testgas ${randomUUID().slice(0, 8)}`;

/** A client with one location, one batch, initialized — so it owns real evidence. */
async function makeClient(opts: { sites?: string[]; quantity?: number } = {}) {
  const pm = await makeProjectManager(`PM ${randomUUID().slice(0, 8)}`);
  const projectNumber = uniqueProjectNumber();
  const siteNames = opts.sites ?? ['Delmas'];

  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber,
      projectManagerId: pm.id,
      site: { name: siteNames[0]!, location: 'Mpumalanga' },
    },
  });
  expect(created.statusCode).toBe(201);
  const project = created.json().project;

  for (const name of siteNames.slice(1)) {
    const res = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/sites`,
      headers: bearer(techToken),
      payload: { name, location: 'Elsewhere' },
    });
    expect(res.statusCode).toBe(201);
  }

  const full = await app.inject({
    method: 'GET',
    url: `/projects/${project.id}`,
    headers: bearer(techToken),
  });
  const sites = full.json().project.sites as { id: string; name: string }[];

  const batchRes = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: {
      projectId: project.id,
      siteId: sites[0]!.id,
      clientRequestId: randomUUID(),
      lines: [
        {
          gasTypeId: nitrogenId,
          supplierId: await supplierForGas(nitrogenId),
          quantity: opts.quantity ?? 3,
          initialDeliveryPoint: 'STORES',
        },
      ],
    },
  });
  expect(batchRes.statusCode).toBe(201);
  const batchId = batchRes.json().batch.id as string;
  const serials = batchRes.json().serials as string[];

  await initializeBatch(app, techToken, batchId, serials);

  return { projectId: project.id, projectNumber, sites, batchId, serials, pm };
}

/** Every table the cascade is supposed to empty, for one project. */
async function remainsOf(projectId: string) {
  const batches = await prisma.batch.findMany({ where: { projectId }, select: { id: true } });
  const ids = batches.map((b) => b.id);
  return {
    project: await prisma.project.count({ where: { id: projectId } }),
    sites: await prisma.site.count({ where: { projectId } }),
    batches: batches.length,
    cylinders: await prisma.cylinder.count({ where: { batchId: { in: ids } } }),
    lines: await prisma.batchLine.count({ where: { batchId: { in: ids } } }),
    initializations: await prisma.batchInitialization.count({ where: { batchId: { in: ids } } }),
    photos: await prisma.batchPhoto.count({ where: { batchId: { in: ids } } }),
  };
}

describe('DELETE /admin/clients/:id', () => {
  it('reports the impact before anything is destroyed', async () => {
    const { projectId } = await makeClient({ quantity: 4 });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/clients/${projectId}/impact`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const { impact } = res.json();
    expect(impact).toMatchObject({ sites: 1, batches: 1, cylinders: 4, initializations: 1 });
    // Initializing scans every cylinder, so there is one movement event each.
    expect(impact.movementEvents).toBeGreaterThanOrEqual(4);
    expect(impact.photos).toBe(1);

    // And nothing has actually gone: /impact is a question, not an instruction.
    expect(await remainsOf(projectId)).toMatchObject({ project: 1, batches: 1, cylinders: 4 });
  });

  it('removes the client, its locations, and every trace of its deliveries', async () => {
    const { projectId, batchId } = await makeClient({ sites: ['Delmas', 'Durban'], quantity: 3 });

    const photoPaths = (
      await prisma.batchPhoto.findMany({ where: { batchId }, select: { path: true } })
    ).map((p) => p.path);
    expect(photoPaths.length).toBeGreaterThan(0);

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/clients/${projectId}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);

    expect(await remainsOf(projectId)).toEqual({
      project: 0,
      sites: 0,
      batches: 0,
      cylinders: 0,
      lines: 0,
      initializations: 0,
      photos: 0,
    });

    // The queued QR-sheet mail is matched through its JSON payload, not an FK, so it
    // is the one thing a cascade can plausibly forget.
    const emails = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "OutboundEmail" WHERE "payload"->>'batchId' = ${batchId}
    `;
    expect(Number(emails[0]!.count)).toBe(0);

    // And the evidence itself, not just the rows pointing at it.
    const stored = await prisma.storedFile.count({ where: { path: { in: photoPaths } } });
    expect(stored).toBe(0);
  });

  it('leaves every other client untouched', async () => {
    const keep = await makeClient({ quantity: 2 });
    const drop = await makeClient({ quantity: 2 });

    await app.inject({
      method: 'DELETE',
      url: `/admin/clients/${drop.projectId}`,
      headers: bearer(adminToken),
    });

    expect(await remainsOf(keep.projectId)).toMatchObject({
      project: 1,
      sites: 1,
      batches: 1,
      cylinders: 2,
    });
  });
});

describe('DELETE /admin/clients/:id/locations', () => {
  it('deletes one location and the batches delivered to it, keeping the others', async () => {
    const { projectId, sites } = await makeClient({ sites: ['Delmas', 'Cape Town'] });
    const delmas = sites[0]!;
    const capeTown = sites[1]!;

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/clients/${projectId}/locations/${delmas.id}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);

    expect(await prisma.site.count({ where: { id: delmas.id } })).toBe(0);
    expect(await prisma.site.count({ where: { id: capeTown.id } })).toBe(1);
    // The client survives a location going.
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(1);
    expect(await prisma.batch.count({ where: { projectId } })).toBe(0);
  });

  it('refuses a location id belonging to a DIFFERENT client', async () => {
    const a = await makeClient();
    const b = await makeClient();

    const res = await app.inject({
      method: 'DELETE',
      // b's site, addressed under a's client — a mistyped id that happens to exist.
      url: `/admin/clients/${a.projectId}/locations/${b.sites[0]!.id}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(404);
    expect(await prisma.site.count({ where: { id: b.sites[0]!.id } })).toBe(1);
  });

  /**
   * The case that makes this more than a `deleteMany`.
   *
   * `POST /transfers` refuses a destination outside the batch's own project, so
   * cylinders never park at another CLIENT's site — but they move freely between one
   * client's own locations. Delete Cape Town while a Delmas batch is sitting there and
   * the cylinders must survive, because their batch does: it belongs to Delmas.
   */
  it('sends surviving cylinders parked at a deleted location back to Stores', async () => {
    const { projectId, sites, batchId, serials } = await makeClient({
      sites: ['Delmas', 'Cape Town'],
      quantity: 2,
    });
    const delmas = sites[0]!;
    const capeTown = sites[1]!;

    const transfer = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        ...testSignOff(),
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId: capeTown.id },
        scans: serials.map((serialCode) => ({
          serialCode,
          qrPayload: qrPayloadFor(serialCode),
          scannedAt: new Date().toISOString(),
        })),
      },
    });
    expect(transfer.statusCode).toBe(201);
    expect(await prisma.cylinder.count({ where: { currentSiteId: capeTown.id } })).toBe(2);

    // Delete the location they are VISITING, not the one their batch belongs to.
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/clients/${projectId}/locations/${capeTown.id}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);

    // The batch is a Delmas batch, so it survives — with its cylinders back at Stores
    // rather than pointing at a site row that no longer exists.
    expect(await prisma.batch.count({ where: { id: batchId } })).toBe(1);
    expect(await prisma.site.count({ where: { id: delmas.id } })).toBe(1);
    const survivors = await prisma.cylinder.findMany({
      where: { batchId },
      select: { currentSiteId: true, status: true },
    });
    expect(survivors).toHaveLength(2);
    // Both halves: the schema's CHECK constraint refuses a DEPLOYED cylinder with no
    // site, so "back to Stores" has to mean the status as well as the location.
    expect(survivors.every((c) => c.currentSiteId === null)).toBe(true);
    expect(survivors.every((c) => c.status === 'IN_STORES')).toBe(true);
  });

  it('deletes every location at once, keeping the client', async () => {
    const { projectId } = await makeClient({ sites: ['A', 'B', 'C'] });

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/clients/${projectId}/locations`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().impact.sites).toBe(3);

    expect(await prisma.site.count({ where: { projectId } })).toBe(0);
    expect(await prisma.project.count({ where: { id: projectId } })).toBe(1);
  });
});

describe('DELETE /admin/users/:id', () => {
  it('deletes an account outright when it has authored nothing', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: {
        email: `fresh-${randomUUID().slice(0, 8)}@demo.local`,
        name: 'Never Worked',
        role: 'TECHNICIAN',
        password: TEST_PASSWORD,
      },
    });
    const id = created.json().user.id as string;

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${id}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authoredRecordsKept).toBe(0);
    // Genuinely gone — there was nothing pointing at them to preserve.
    expect(await prisma.user.count({ where: { id } })).toBe(0);
  });

  /**
   * The deliberate asymmetry. Cascading here would delete every batch the technician
   * booked in — for OTHER clients — so the account is destroyed and the work is not.
   */
  it('keeps the work but destroys the account when the person has history', async () => {
    const email = `worker-${randomUUID().slice(0, 8)}@demo.local`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: { email, name: 'Did Some Work', role: 'TECHNICIAN', password: TEST_PASSWORD },
    });
    const id = created.json().user.id as string;
    const workerToken = await loginWith(email);

    const pm = await makeProjectManager('Keeper PM');
    const project = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(workerToken),
      payload: {
        projectNumber: uniqueProjectNumber(),
        projectManagerId: pm.id,
        site: { name: 'Worked Yard', location: 'GP' },
      },
    });
    const batch = await app.inject({
      method: 'POST',
      url: '/batches',
      headers: bearer(workerToken),
      payload: {
        projectId: project.json().project.id,
        siteId: project.json().project.sites[0].id,
        clientRequestId: randomUUID(),
        lines: [
          {
            gasTypeId: nitrogenId,
            supplierId: await supplierForGas(nitrogenId),
            quantity: 2,
            initialDeliveryPoint: 'STORES',
          },
        ],
      },
    });
    const batchId = batch.json().batch.id as string;

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${id}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authoredRecordsKept).toBeGreaterThan(0);

    // The batch they booked in is still there, still attributed to them by name.
    const kept = await prisma.batch.findUnique({
      where: { id: batchId },
      include: { createdBy: { select: { name: true, deletedAt: true, active: true } } },
    });
    expect(kept).not.toBeNull();
    expect(kept!.createdBy.name).toBe('Did Some Work');

    // But the account is unusable and the address is free again.
    expect(kept!.createdBy.deletedAt).not.toBeNull();
    expect(kept!.createdBy.active).toBe(false);
    await expect(loginWith(email)).rejects.toThrow(/401/);

    // Released: the same address can be given to a new person.
    const reuse = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: { email, name: 'Their Replacement', role: 'TECHNICIAN', password: TEST_PASSWORD },
    });
    expect(reuse.statusCode).toBe(201);
  });

  it('drops the deleted account out of the console list', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: bearer(adminToken),
    });
    const names = (list.json().users as { name: string }[]).map((u) => u.name);
    expect(names).not.toContain('Did Some Work');
  });

  it('refuses to let an admin delete themselves', async () => {
    const me = await prisma.user.findFirstOrThrow({ where: { email: DEMO.admin } });
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/users/${me.id}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CANNOT_DELETE_SELF');
  });

  /**
   * Deactivating the other admins rather than deleting them: the guard counts ACTIVE
   * admins, and leaving the seeded ones intact keeps this test from setting fire to
   * every test after it.
   */
  it('refuses to delete the last remaining active admin', async () => {
    const email = `admin2-${randomUUID().slice(0, 8)}@demo.local`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: { email, name: 'Second Admin', role: 'ADMIN', password: TEST_PASSWORD },
    });
    const secondId = created.json().user.id as string;
    const secondToken = await loginWith(email);

    const others = await prisma.user.findMany({
      where: { role: 'ADMIN', active: true, deletedAt: null, id: { not: secondId } },
      select: { id: true },
    });
    await prisma.user.updateMany({
      where: { id: { in: others.map((u) => u.id) } },
      data: { active: false },
    });

    try {
      // The only active admin left is the caller, so this is refused — by the
      // self-deletion guard first, which is the one that fires for this shape.
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/users/${secondId}`,
        headers: bearer(secondToken),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CANNOT_DELETE_SELF');

      // Reactivate one other admin and have THEM try to delete the second: now the
      // count is two, so it succeeds — proving the guard tracks the count, not a role.
      const other = await prisma.user.findFirstOrThrow({ where: { id: others[0]!.id } });
      await prisma.user.update({ where: { id: other.id }, data: { active: true } });
      const otherToken = await loginAs(app, other.email);
      const ok = await app.inject({
        method: 'DELETE',
        url: `/admin/users/${secondId}`,
        headers: bearer(otherToken),
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: others.map((u) => u.id) } },
        data: { active: true },
      });
    }
  });
});

describe('gases, suppliers and their pairing', () => {
  it('adds a gas, and refuses a duplicate prefix', async () => {
    const name = unusedGasName();
    const prefix = await unusedPrefix();
    const created = await app.inject({
      method: 'POST',
      url: '/admin/gas-types',
      headers: bearer(adminToken),
      payload: { name, prefix },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().gasType).toMatchObject({ name, prefix, usageCount: 0 });

    const clash = await app.inject({
      method: 'POST',
      url: '/admin/gas-types',
      headers: bearer(adminToken),
      payload: { name: unusedGasName(), prefix },
    });
    // Two gases on one prefix would issue serials that collide on a physical label.
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toMatch(/prefix/);
  });

  it('pairs and unpairs a supplier without touching any batch', async () => {
    const gas = await app.inject({
      method: 'POST',
      url: '/admin/gas-types',
      headers: bearer(adminToken),
      payload: { name: unusedGasName(), prefix: await unusedPrefix() },
    });
    const gasId = gas.json().gasType.id as string;

    const supplier = await app.inject({
      method: 'POST',
      url: '/admin/suppliers',
      headers: bearer(adminToken),
      payload: { name: `Supplier ${randomUUID().slice(0, 6)}` },
    });
    const supplierId = supplier.json().supplier.id as string;

    const paired = await app.inject({
      method: 'POST',
      url: `/admin/gas-types/${gasId}/suppliers`,
      headers: bearer(adminToken),
      payload: { supplierId },
    });
    expect(paired.statusCode).toBe(200);
    expect(paired.json().gasType.suppliers.map((s: { id: string }) => s.id)).toContain(supplierId);

    // Idempotent: pairing twice is the same end state, not a 409.
    const again = await app.inject({
      method: 'POST',
      url: `/admin/gas-types/${gasId}/suppliers`,
      headers: bearer(adminToken),
      payload: { supplierId },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().gasType.suppliers).toHaveLength(1);

    const unpaired = await app.inject({
      method: 'DELETE',
      url: `/admin/gas-types/${gasId}/suppliers/${supplierId}`,
      headers: bearer(adminToken),
    });
    expect(unpaired.statusCode).toBe(200);
    expect(unpaired.json().gasType.suppliers).toHaveLength(0);
    // The supplier itself is untouched — unpairing is not deleting.
    expect(await prisma.supplier.count({ where: { id: supplierId } })).toBe(1);
  });

  it('deletes an unused gas outright', async () => {
    const gas = await app.inject({
      method: 'POST',
      url: '/admin/gas-types',
      headers: bearer(adminToken),
      payload: { name: unusedGasName(), prefix: await unusedPrefix() },
    });
    const gasId = gas.json().gasType.id as string;

    const impact = await app.inject({
      method: 'GET',
      url: `/admin/gas-types/${gasId}/impact`,
      headers: bearer(adminToken),
    });
    expect(impact.json().impact.batches).toBe(0);

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/gas-types/${gasId}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.gasType.count({ where: { id: gasId } })).toBe(0);
  });

  it('deleting a gas takes the batches that used it', async () => {
    const prefix = await unusedPrefix();
    const gas = await app.inject({
      method: 'POST',
      url: '/admin/gas-types',
      headers: bearer(adminToken),
      payload: { name: unusedGasName(), prefix },
    });
    const gasId = gas.json().gasType.id as string;

    const supplier = await app.inject({
      method: 'POST',
      url: '/admin/suppliers',
      headers: bearer(adminToken),
      payload: { name: `Supply ${randomUUID().slice(0, 6)}`, gasTypeIds: [gasId] },
    });
    const supplierId = supplier.json().supplier.id as string;

    const pm = await makeProjectManager('Xenon PM');
    const project = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber: uniqueProjectNumber(),
        projectManagerId: pm.id,
        site: { name: 'Xe Yard', location: 'GP' },
      },
    });
    const batch = await app.inject({
      method: 'POST',
      url: '/batches',
      headers: bearer(techToken),
      payload: {
        projectId: project.json().project.id,
        siteId: project.json().project.sites[0].id,
        clientRequestId: randomUUID(),
        lines: [{ gasTypeId: gasId, supplierId, quantity: 2, initialDeliveryPoint: 'STORES' }],
      },
    });
    expect(batch.statusCode).toBe(201);
    const batchId = batch.json().batch.id as string;

    const impact = await app.inject({
      method: 'GET',
      url: `/admin/gas-types/${gasId}/impact`,
      headers: bearer(adminToken),
    });
    expect(impact.json().impact).toMatchObject({ batches: 1, cylinders: 2 });

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/gas-types/${gasId}`,
      headers: bearer(adminToken),
    });
    expect(res.statusCode).toBe(200);

    expect(await prisma.batch.count({ where: { id: batchId } })).toBe(0);
    expect(await prisma.cylinder.count({ where: { batchId } })).toBe(0);
    expect(await prisma.gasType.count({ where: { id: gasId } })).toBe(0);
    // The serial counter goes too, so re-adding XE later starts at 001 rather than
    // handing out numbers that look like they belong to batches nobody can find.
    expect(await prisma.serialSequence.count({ where: { prefix } })).toBe(0);
  });

  it('is refused for a non-admin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/gas-types',
      headers: bearer(storesToken),
    });
    expect(res.statusCode).toBe(403);
  });
});
