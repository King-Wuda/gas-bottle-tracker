import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { qrPayloadFor } from '../src/services/qr.js';
import {
  bearer,
  DEMO,
  loginAs,
  initializeBatch,
  makeProjectManager,
  resetDb,
  supplierForGas,
  testPhoto,
  uniqueProjectNumber,
} from './helpers.js';

/**
 * The admin console, and the one exception to mandatory scanning.
 *
 * The through-line of every test here: this system's product is evidence. An admin can
 * correct a mis-keyed batch and can move stock without a camera, but neither may
 * quietly rewrite what the movement log already proves, and both leave a trail saying
 * which happened.
 */

let app: FastifyInstance;
let adminToken: string;
let techToken: string;
let storesToken: string;
let nitrogenId: string;
let argonId: string;
let projectId: string;
let siteId: string;
let otherSiteId: string;

beforeAll(async () => {
  await resetDb();
  app = await buildApp();
  await app.ready();

  adminToken = await loginAs(app, DEMO.admin);
  techToken = await loginAs(app, DEMO.technician);
  storesToken = await loginAs(app, DEMO.stores);

  const gt = await app.inject({ method: 'GET', url: '/gas-types', headers: bearer(adminToken) });
  nitrogenId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Nitrogen').id;
  argonId = gt.json().gasTypes.find((g: { name: string }) => g.name === 'Argon').id;

  const pm = await makeProjectManager('Admin Suite PM');
  const created = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: bearer(techToken),
    payload: {
      projectNumber: uniqueProjectNumber(),
      projectManagerId: pm.id,
      site: { name: 'Yard Admin', location: 'JHB' },
    },
  });
  projectId = created.json().project.id;
  siteId = created.json().project.sites[0].id;

  const second = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/sites`,
    headers: bearer(techToken),
    payload: { name: 'Yard Admin Two', location: 'PTA' },
  });
  otherSiteId = second.json().site.id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function makeBatch(
  lines: { gasTypeId: string; quantity: number }[],
): Promise<{ batchId: string; serials: string[]; lineIds: string[] }> {
  const payloadLines = await Promise.all(
    lines.map(async (l) => ({
      gasTypeId: l.gasTypeId,
      supplierId: await supplierForGas(l.gasTypeId),
      quantity: l.quantity,
      initialDeliveryPoint: 'STORES' as const,
    })),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: bearer(techToken),
    payload: { projectId, siteId, clientRequestId: randomUUID(), lines: payloadLines },
  });
  if (res.statusCode !== 201) throw new Error(`makeBatch: ${res.statusCode} ${res.body}`);
  const batchId = res.json().batch.id as string;
  const serials = res.json().serials as string[];

  // Scan the batch in so it is legal to move. Transfers and returns refuse an
  // uninitialized batch (409), which is the point of the step — but it is not what
  // any test below is about, so it happens here once.
  await initializeBatch(app, techToken, batchId, serials);
  return {
    batchId,
    serials,
    lineIds: res.json().batch.lines.map((l: { id: string }) => l.id),
  };
}

const scan = (serialCode: string) => ({
  serialCode,
  qrPayload: qrPayloadFor(serialCode),
  scannedAt: new Date().toISOString(),
});

/** Long enough for `passwordSchema`, which the seed password is not. */
const NEW_USER_PASSWORD = 'correct-horse-battery';

/** `loginAs` signs in with the SEED password; accounts created here have their own. */
async function loginNew(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: NEW_USER_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`loginNew(${email}): ${res.statusCode} ${res.body}`);
  return res.json().accessToken as string;
}

// ------------------------------------------------------------------ users

describe('admin — people', () => {
  it('is closed to every role but ADMIN', async () => {
    for (const token of [techToken, storesToken]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: bearer(token),
      });
      expect(res.statusCode).toBe(403);
    }
    const anon = await app.inject({ method: 'GET', url: '/admin/users' });
    expect(anon.statusCode).toBe(401);
  });

  it('creates an account that can immediately sign in', async () => {
    const email = `tech.${Date.now()}@demo.local`;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: { email, name: 'New Tech', role: 'TECHNICIAN', password: NEW_USER_PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe('TECHNICIAN');
    expect(res.json().user.active).toBe(true);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: NEW_USER_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses a duplicate email rather than silently taking over the account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: {
        email: DEMO.technician,
        name: 'Impostor',
        role: 'ADMIN',
        password: NEW_USER_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('deactivating blocks sign-in, revokes live sessions, and keeps the audit trail', async () => {
    const email = `leaver.${Date.now()}@demo.local`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: { email, name: 'Leaver', role: 'TECHNICIAN', password: NEW_USER_PASSWORD },
    });
    const userId = created.json().user.id;

    // Sign in and hold a refresh token, the way a phone in the field would.
    const session = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: NEW_USER_PASSWORD },
    });
    const refreshToken = session.json().refreshToken;

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${userId}`,
      headers: bearer(adminToken),
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.active).toBe(false);

    // Cannot sign in again...
    const retry = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: NEW_USER_PASSWORD },
    });
    expect(retry.statusCode).toBe(401);

    // ...and the session already in their pocket cannot be renewed. Without this, a
    // deactivated account keeps working for as long as it keeps refreshing.
    const refresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBe(401);

    // The row is still there — it is the answer to "who did this?" on anything they
    // ever recorded.
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('refuses to let an admin deactivate or demote themselves', async () => {
    const me = await prisma.user.findUniqueOrThrow({ where: { email: DEMO.admin } });

    const deactivate = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${me.id}`,
      headers: bearer(adminToken),
      payload: { active: false },
    });
    expect(deactivate.statusCode).toBe(400);
    expect(deactivate.json().error.code).toBe('CANNOT_DEMOTE_SELF');

    const demote = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${me.id}`,
      headers: bearer(adminToken),
      payload: { role: 'TECHNICIAN' },
    });
    expect(demote.statusCode).toBe(400);

    // Still an active admin — the refusal actually held.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    expect(after.active).toBe(true);
    expect(after.role).toBe('ADMIN');
  });

  it('deactivating a spare admin is fine while another one remains', async () => {
    const adminsBefore = await prisma.user.count({ where: { role: 'ADMIN', active: true } });
    const email = `spare.admin.${Date.now()}@demo.local`;
    const spare = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: { email, name: 'Spare Admin', role: 'ADMIN', password: NEW_USER_PASSWORD },
    });
    const spareId = spare.json().user.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${spareId}`,
      headers: bearer(adminToken),
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    // Relative, not absolute: the seed now creates the two real admins alongside the
    // demo one, so "exactly 1" would pin a seed detail rather than the behaviour.
    expect(await prisma.user.count({ where: { role: 'ADMIN', active: true } })).toBe(adminsBefore);
  });

  it('refuses to remove the last active admin, even from a token that outlived its account', async () => {
    // The reachable path to this guard is a race, not a click: two admins, one of whom
    // is deactivated elsewhere while still holding a valid access token. Tokens are
    // signed and self-contained, so that token keeps working until it expires — and
    // without this guard its holder could take the organisation's last admin with them.
    const email = `racer.admin.${Date.now()}@demo.local`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: bearer(adminToken),
      payload: { email, name: 'Racing Admin', role: 'ADMIN', password: NEW_USER_PASSWORD },
    });
    const racerId = created.json().user.id;
    const racerToken = await loginNew(email);

    // Their account goes away underneath them (another session, another admin).
    await prisma.user.update({ where: { id: racerId }, data: { active: false } });

    // Park every other admin so the seeded one really IS the last. The seed creates
    // the two real admins (Jacques, Tumelo) as well as the demo one, and this test is
    // about the guard, not about how many accounts a fresh install happens to have.
    const seeded = await prisma.user.findUniqueOrThrow({ where: { email: DEMO.admin } });
    const parked = await prisma.user.findMany({
      where: { role: 'ADMIN', active: true, id: { not: seeded.id } },
      select: { id: true },
    });
    await prisma.user.updateMany({
      where: { id: { in: parked.map((u) => u.id) } },
      data: { active: false },
    });
    expect(await prisma.user.count({ where: { role: 'ADMIN', active: true } })).toBe(1);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${seeded.id}`,
      headers: bearer(racerToken),
      payload: { active: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('LAST_ADMIN');

    // The organisation still has a way in.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(after.active).toBe(true);
    expect(after.role).toBe('ADMIN');

    // Put the parked admins back: resetDb reactivates seed accounts, but the tests
    // after this one in the same file run before that happens.
    await prisma.user.updateMany({
      where: { id: { in: parked.map((u) => u.id) } },
      data: { active: true },
    });
  });
});

// -------------------------------------------------------- project managers

describe('admin — project managers', () => {
  it('adds one, and it appears in the picker every flow uses', async () => {
    const email = `pm.${Date.now()}@demo.local`;
    const res = await app.inject({
      method: 'POST',
      url: '/admin/project-managers',
      headers: bearer(adminToken),
      payload: { name: 'Fresh PM', email },
    });
    expect(res.statusCode).toBe(201);

    const picker = await app.inject({
      method: 'GET',
      url: '/project-managers',
      headers: bearer(techToken),
    });
    expect(picker.json().projectManagers.map((m: { email: string }) => m.email)).toContain(email);
  });

  it('a deactivated manager drops out of the picker but stays resolvable', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/project-managers',
      headers: bearer(adminToken),
      payload: { name: 'Departing PM', email: `dep.${Date.now()}@demo.local` },
    });
    const pmId = created.json().projectManager.id;

    await app.inject({
      method: 'PATCH',
      url: `/admin/project-managers/${pmId}`,
      headers: bearer(adminToken),
      payload: { active: false },
    });

    const picker = await app.inject({
      method: 'GET',
      url: '/project-managers',
      headers: bearer(techToken),
    });
    expect(picker.json().projectManagers.map((m: { id: string }) => m.id)).not.toContain(pmId);

    // Still on record — a batch addressed to them must keep naming them.
    expect(await prisma.projectManager.findUnique({ where: { id: pmId } })).not.toBeNull();

    // And the admin list still shows them, so they can be brought back.
    const adminList = await app.inject({
      method: 'GET',
      url: '/admin/project-managers',
      headers: bearer(adminToken),
    });
    expect(adminList.json().projectManagers.map((m: { id: string }) => m.id)).toContain(pmId);
  });

  it('correcting a manager’s address does not rewrite where past batches were sent', async () => {
    const original = `orig.${Date.now()}@demo.local`;
    const created = await app.inject({
      method: 'POST',
      url: '/admin/project-managers',
      headers: bearer(adminToken),
      payload: { name: 'Typo PM', email: original },
    });
    const pmId = created.json().projectManager.id;

    const project = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: bearer(techToken),
      payload: {
        projectNumber: uniqueProjectNumber(),
        projectManagerId: pmId,
        site: { name: 'Yard Typo', location: 'JHB' },
      },
    });
    const pid = project.json().project.id;
    const sid = project.json().project.sites[0].id;

    const batch = await app.inject({
      method: 'POST',
      url: '/batches',
      headers: bearer(techToken),
      payload: {
        projectId: pid,
        siteId: sid,
        clientRequestId: randomUUID(),
        lines: [
          {
            gasTypeId: nitrogenId,
            supplierId: await supplierForGas(nitrogenId),
            quantity: 1,
            initialDeliveryPoint: 'STORES',
          },
        ],
      },
    });
    const batchId = batch.json().batch.id;

    await app.inject({
      method: 'PATCH',
      url: `/admin/project-managers/${pmId}`,
      headers: bearer(adminToken),
      payload: { email: `fixed.${Date.now()}@demo.local` },
    });

    // "Where did this batch's QR sheet actually go?" must still answer truthfully.
    const after = await app.inject({
      method: 'GET',
      url: `/batches/${batchId}`,
      headers: bearer(adminToken),
    });
    expect(after.json().batch.projectManagerEmail).toBe(original);
  });
});

// ----------------------------------------------------- batch corrections

describe('admin — correcting a batch', () => {
  it('corrects paperwork and records what changed, by whom', async () => {
    const { batchId, lineIds } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 2 }]);
    const otherSupplier = await prisma.gasSupplier.findFirstOrThrow({
      where: { gasTypeId: nitrogenId, supplierId: { not: await supplierForGas(nitrogenId) } },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: {
        siteId: otherSiteId,
        lines: [{ id: lineIds[0], supplierId: otherSupplier.supplierId }],
        reason: 'supplier keyed in wrong on delivery',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().batch.siteId).toBe(otherSiteId);

    const log = await app.inject({
      method: 'GET',
      url: `/admin/batches/${batchId}/amendments`,
      headers: bearer(adminToken),
    });
    const entry = log.json().amendments[0];
    expect(entry.reason).toBe('supplier keyed in wrong on delivery');
    expect(entry.userName).toBeTruthy();
    expect(entry.changes.join(' ')).toContain('Site');
  });

  it('grows a line by allocating real serials', async () => {
    const { batchId, lineIds } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 2 }]);

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { lines: [{ id: lineIds[0], quantity: 5 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().batch.quantity).toBe(5);
    expect(res.json().batch.cylinders).toHaveLength(5);

    // The new cylinders are real: unique serials, and an INTAKE each.
    const serials = res.json().batch.cylinders.map((c: { serialCode: string }) => c.serialCode);
    expect(new Set(serials).size).toBe(5);
    const intakes = await prisma.movementEvent.count({
      where: { type: 'INTAKE', cylinder: { batchId } },
    });
    expect(intakes).toBe(5);
  });

  it('shrinks a line only as far as cylinders that never moved', async () => {
    const { batchId, serials, lineIds } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 4 }]);

    // Move two of them out. Those two are now evidence.
    const moved = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [scan(serials[0]!), scan(serials[1]!)],
      },
    });
    expect(moved.statusCode).toBe(201);

    // Down to 2 is fine: exactly the two that stayed at stores are dropped.
    const ok = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { lines: [{ id: lineIds[0], quantity: 2 }] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().batch.cylinders).toHaveLength(2);

    // Down to 1 would have to delete a cylinder that is standing on a site — that is
    // a rental someone is being charged for, not a typo.
    const refused = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { lines: [{ id: lineIds[0], quantity: 1 }] },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('CYLINDERS_ALREADY_MOVED');

    // And nothing was quietly removed on the way to that refusal.
    expect(await prisma.cylinder.count({ where: { batchId } })).toBe(2);
  });

  it('refuses to remove a line whose cylinders have moved', async () => {
    const { batchId, serials, lineIds } = await makeBatch([
      { gasTypeId: nitrogenId, quantity: 2 },
      { gasTypeId: argonId, quantity: 2 },
    ]);

    const nitrogenSerial = serials.find((s) => s.startsWith('NIT'))!;
    await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [scan(nitrogenSerial)],
      },
    });

    const nitrogenLine = (
      await prisma.batchLine.findMany({ where: { batchId, gasTypeId: nitrogenId } })
    )[0]!;
    const refused = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { removeLineIds: [nitrogenLine.id] },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('CYLINDERS_ALREADY_MOVED');

    // The untouched argon line can still go.
    const argonLine = lineIds.find((id) => id !== nitrogenLine.id)!;
    const ok = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { removeLineIds: [argonLine] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().batch.lines).toHaveLength(1);
  });

  it('reassigns the addressee, and future paperwork follows', async () => {
    const { batchId } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 1 }]);
    const successor = await makeProjectManager('Successor PM');

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(adminToken),
      payload: { projectManagerId: successor.id, reason: 'handover' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().batch.projectManagerId).toBe(successor.id);
    // Deliberate reassignment DOES move the address — unlike correcting a typo in the
    // old manager's own record, which must not.
    expect(res.json().batch.projectManagerEmail).toBe(successor.email);
  });

  it('is closed to non-admins', async () => {
    const { batchId } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 1 }]);
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/batches/${batchId}`,
      headers: bearer(techToken),
      payload: { siteId: otherSiteId },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ------------------------------------------------------- the scan override

describe('scan override', () => {
  it('lets an admin transfer without a scan, and marks the hop as unscanned', async () => {
    const { batchId, serials } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 3 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(adminToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [],
        overrideSerials: [serials[0]!, serials[1]!],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transfer.movedSerials).toHaveLength(2);
    expect(res.json().transfer.overriddenSerials.sort()).toEqual([serials[0]!, serials[1]!].sort());

    // The trail says these were asserted, not seen. That distinction is the whole
    // reason the override is allowed to exist at all.
    const events = await prisma.movementEvent.findMany({
      where: { type: 'TRANSFER', cylinder: { batchId } },
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.overridden)).toBe(true);

    // The third cylinder did not move: an override selects, it does not sweep.
    const stillHome = await prisma.cylinder.count({
      where: { batchId, status: 'IN_STORES' },
    });
    expect(stillHome).toBe(1);
  });

  it('refuses an override from a technician or a stores manager', async () => {
    const { batchId, serials } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 1 }]);

    const transfer = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [],
        overrideSerials: [serials[0]!],
      },
    });
    expect(transfer.statusCode).toBe(403);
    expect(transfer.json().error.code).toBe('OVERRIDE_FORBIDDEN');

    // Refused, not silently ignored: nothing moved.
    expect(await prisma.cylinder.count({ where: { batchId, status: { not: 'IN_STORES' } } })).toBe(
      0,
    );

    const ret = await app.inject({
      method: 'POST',
      url: '/returns',
      headers: bearer(storesToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        scans: [],
        overrideSerials: [serials[0]!],
        driverName: 'Sipho',
        signaturePng: 'x'.repeat(100),
      },
    });
    expect(ret.statusCode).toBe(403);
  });

  it('keeps a real scan as a scan when the same serial is also overridden', async () => {
    const { batchId, serials } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 2 }]);

    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(adminToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [scan(serials[0]!)],
        // The client sends both — "override all" ran after one was already scanned.
        overrideSerials: [serials[0]!, serials[1]!],
      },
    });
    expect(res.statusCode).toBe(201);

    // The scanned one keeps its stronger evidence; only the other is marked.
    expect(res.json().transfer.overriddenSerials).toEqual([serials[1]!]);
    const scanned = await prisma.movementEvent.findFirstOrThrow({
      where: { type: 'TRANSFER', cylinder: { serialCode: serials[0]! } },
    });
    expect(scanned.overridden).toBe(false);
  });

  it('still refuses a submission with nothing selected at all', async () => {
    const { batchId } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 1 }]);
    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(adminToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'STORES' },
        scans: [],
        overrideSerials: [],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

// -------------------------------------------- handing a batch over on transfer

describe('transfer — project manager handover', () => {
  it('reassigns the batch as part of the move, and records who took it', async () => {
    const { batchId, serials } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 2 }]);
    const successor = await makeProjectManager('Handover PM');

    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [scan(serials[0]!)],
        projectManagerId: successor.id,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transfer.projectManagerId).toBe(successor.id);

    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.projectManagerId).toBe(successor.id);
    expect(batch.projectManagerEmail).toBe(successor.email);
  });

  it('refuses a handover to a deactivated manager', async () => {
    const { batchId, serials } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 1 }]);
    const gone = await makeProjectManager('Gone PM');
    await prisma.projectManager.update({ where: { id: gone.id }, data: { active: false } });

    const res = await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [scan(serials[0]!)],
        projectManagerId: gone.id,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PROJECT_MANAGER');

    // Refused before anything moved — the cylinder is still at stores.
    expect(await prisma.cylinder.count({ where: { batchId, status: 'IN_STORES' } })).toBe(1);
  });

  it('leaves the manager alone when the transfer does not name one', async () => {
    const { batchId, serials } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 1 }]);
    const before = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });

    await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [scan(serials[0]!)],
      },
    });

    const after = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(after.projectManagerId).toBe(before.projectManagerId);
    expect(after.projectManagerEmail).toBe(before.projectManagerEmail);
  });
});

// ------------------------------------------------ partial movement, repeated

describe('partial movement', () => {
  it('a batch can be transferred again and again, splitting further each time', async () => {
    const { batchId, serials } = await makeBatch([{ gasTypeId: nitrogenId, quantity: 4 }]);

    const move = (serial: string, destination: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/transfers',
        headers: bearer(techToken),
        payload: {
          photo: testPhoto(),
          batchId,
          clientRequestId: randomUUID(),
          destination,
          scans: [scan(serial)],
        },
      });

    expect((await move(serials[0]!, { type: 'SITE', siteId })).statusCode).toBe(201);
    // The second transfer of the SAME batch used to be hidden from the list entirely.
    expect((await move(serials[1]!, { type: 'SITE', siteId: otherSiteId })).statusCode).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `/batches/${batchId}`,
      headers: bearer(techToken),
    });
    const dist = res.json().batch.distribution as {
      kind: string;
      count: number;
      locationName: string;
    }[];

    expect(dist.find((d) => d.kind === 'STORES')?.count).toBe(2);
    const onSites = dist.filter((d) => d.kind === 'SITE');
    expect(onSites).toHaveLength(2);
    expect(onSites.every((d) => d.count === 1)).toBe(true);

    // And it is still offered by the Transfer tab, because 2 are still at stores.
    const list = await app.inject({
      method: 'GET',
      url: '/batches?scope=transfer&status=active',
      headers: bearer(techToken),
    });
    expect(list.json().batches.map((b: { id: string }) => b.id)).toContain(batchId);
  });

  it('splits the breakdown per gas, not just per location', async () => {
    const { batchId, serials } = await makeBatch([
      { gasTypeId: nitrogenId, quantity: 3 },
      { gasTypeId: argonId, quantity: 2 },
    ]);
    const nitrogen = serials.filter((s) => s.startsWith('NIT'));

    await app.inject({
      method: 'POST',
      url: '/transfers',
      headers: bearer(techToken),
      payload: {
        photo: testPhoto(),
        batchId,
        clientRequestId: randomUUID(),
        destination: { type: 'SITE', siteId },
        scans: [scan(nitrogen[0]!)],
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/batches/${batchId}`,
      headers: bearer(techToken),
    });
    const dist = res.json().batch.distribution as {
      gasTypeId: string;
      kind: string;
      count: number;
    }[];

    // "Of the 3 nitrogen, 1 is on site and 2 are at stores. All 2 argon are at stores."
    const nit = dist.filter((d) => d.gasTypeId === nitrogenId);
    expect(nit.find((d) => d.kind === 'SITE')?.count).toBe(1);
    expect(nit.find((d) => d.kind === 'STORES')?.count).toBe(2);

    const arg = dist.filter((d) => d.gasTypeId === argonId);
    expect(arg).toHaveLength(1);
    expect(arg[0]!.kind).toBe('STORES');
    expect(arg[0]!.count).toBe(2);
  });
});
