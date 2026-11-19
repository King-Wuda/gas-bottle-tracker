import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@gct/shared';
import { prisma } from '../src/db.js';
import { qrPayloadFor } from '../src/services/qr.js';

/**
 * Integration tests share one Postgres DB (single fork). Each suite starts from a
 * clean slate for the mutable tables, keeping the seed's Users and GasTypes.
 */
export async function resetDb(): Promise<void> {
  await ensureTestUsers();
  await prisma.$executeRawUnsafe(
    'TRUNCATE ' +
      [
        'OutboundEmail',
        'MovementEvent',
        'ReturnRecord',
        'Transfer',
        'Cylinder',
        'BatchAmendment',
        'BatchLine',
        'Batch',
        'SerialSequence',
        'Site',
        'Project',
        // Sites hang off clients now, so the directory has to go with them — a
        // leftover McCains would be silently reused by the next file's fixtures and
        // make one suite's data visible to another.
        'Client',
        'ProjectManager',
        'RefreshToken',
      ]
        .map((t) => `"${t}"`)
        .join(', ') +
      ' RESTART IDENTITY CASCADE',
  );

  // Users are NOT truncated — the seed's three accounts are what every suite logs in
  // as. But suites that create their own (the admin console does) would otherwise
  // leave them behind for the next run, and "how many active admins are there?" is a
  // question some of those tests actually assert on. Dropping everything that is not
  // a seed account restores the invariant this function's comment already claims.
  // Safe after the TRUNCATE above: nothing references these rows any more.
  await prisma.user.deleteMany({ where: { email: { notIn: SEED_EMAILS } } });

  // Same reasoning for the seed's own accounts: a suite may have deactivated or
  // demoted one, and the next suite's login would then fail for no visible reason.
  await prisma.user.updateMany({ where: { email: { in: SEED_EMAILS } }, data: { active: true } });
  for (const [key, email] of Object.entries(SEED_ROLES)) {
    await prisma.user.updateMany({ where: { email }, data: { role: key as Role } });
  }

  // A project manager is a login AND a manager row, and the TRUNCATE above took the
  // rows. Put back one for every project-manager login kept — the suite's own and the
  // real owners — so no suite starts with a manager the console cannot list.
  const managers = await prisma.user.findMany({
    where: { role: 'PROJECT_MANAGER', deletedAt: null },
    select: { id: true, name: true, email: true },
  });
  await prisma.projectManager.createMany({
    data: managers.map((u) => ({ userId: u.id, name: u.name, email: u.email })),
  });
}

/** The password `ensureTestUsers` hashes. `SEED_PASSWORD` is honoured so a developer
 *  who sets it locally does not get a suite full of unexplained 401s. */
export const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'gea';
export const DEMO = {
  technician: 'technician@demo.local',
  stores: 'stores@demo.local',
  /** A PROJECT_MANAGER — the role that runs the admin console. */
  admin: 'admin@demo.local',
} as const;

/** The role each seeded demo account is supposed to have, so resetDb can restore it. */
const SEED_ROLES = {
  TECHNICIAN: 'technician@demo.local',
  STORES_MANAGER: 'stores@demo.local',
  PROJECT_MANAGER: 'admin@demo.local',
} as const;

/**
 * The accounts `resetDb` is allowed to keep: this suite's own three, AND the two real
 * project managers the seed creates (Jacques, Tumelo). resetDb deletes every account outside
 * this list, so leaving the real ones out would mean running the tests silently
 * removed the logins the operator actually signs in with.
 */
export const SEED_EMAILS = [
  ...Object.values(DEMO),
  'jacques.viljoen@gmail.com',
  'mashabaindustriesllc@gmail.com',
];

/**
 * Display names for the accounts this suite creates.
 *
 * Exported because the history feed attributes each movement to a user by NAME, and a
 * test asserting on that string should read it from the same place that wrote it —
 * otherwise renaming a fixture breaks a test three files away for no visible reason.
 */
export const DEMO_NAMES = {
  technician: 'Test Technician',
  stores: 'Test Stores Manager',
  admin: 'Test Project Manager',
} as const;

const TEST_USER_NAMES: Record<string, string> = {
  [DEMO.technician]: DEMO_NAMES.technician,
  [DEMO.stores]: DEMO_NAMES.stores,
  [DEMO.admin]: DEMO_NAMES.admin,
};

let testUsersReady = false;

/**
 * Create the three accounts this suite signs in as, if they are not already there.
 *
 * They used to come from `prisma/seed.ts`, which meant two things that were both
 * wrong: `npm test` failed on a database nobody had seeded, and a real install
 * shipped with three publicly-known logins that existed only to serve the tests.
 * A suite's fixtures belong to the suite.
 *
 * The argon2 hash is the expensive part, so it is only computed when something is
 * actually missing — on every run after the first this is one SELECT.
 */
export async function ensureTestUsers(): Promise<void> {
  if (testUsersReady) return;
  const wanted = Object.entries(SEED_ROLES).map(([role, email]) => ({ role: role as Role, email }));
  const existing = await prisma.user.findMany({
    where: { email: { in: wanted.map((w) => w.email) } },
    select: { email: true },
  });
  const missing = wanted.filter((w) => !existing.some((e) => e.email === w.email));
  if (missing.length > 0) {
    const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id });
    for (const m of missing) {
      await prisma.user.create({
        data: {
          email: m.email,
          name: TEST_USER_NAMES[m.email] ?? m.email,
          role: m.role,
          active: true,
          passwordHash,
        },
      });
    }
  }
  testUsersReady = true;
}

/** Logs a seeded demo user in and returns their access token. */
export async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: DEMO_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`loginAs(${email}) failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().accessToken as string;
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/**
 * A project number that satisfies the ######-###-#-## CHECK constraint AND is unique
 * within a run. Nine digits of clock plus a three-digit counter: distinct unless a
 * suite creates a thousand projects inside one millisecond.
 */
let projectNumberCounter = 0;
export function uniqueProjectNumber(): string {
  // 11 digits, 5-3-1-2: eight from the clock and three from a counter, so numbers
  // minted in one run do not collide.
  const clock = String(Date.now() % 100_000_000).padStart(8, '0');
  const seq = String(projectNumberCounter++ % 1000).padStart(3, '0');
  const digits = `${clock}${seq}`;
  return `${digits.slice(0, 5)}-${digits.slice(5, 8)}-${digits.slice(8, 9)}-${digits.slice(9, 11)}`;
}

/**
 * A project manager to point a project at. `POST /projects` takes an id now, so tests
 * create the manager directly rather than having the endpoint upsert one from a typed
 * email — which is the behaviour the change spec removed.
 *
 * A manager is always a login as well (`ProjectManager.userId` is required), so this
 * makes both. The login has no usable password — nothing signs in as it — and an
 * `@demo.local` address, so `reset:data` clears it with the rest of the test residue.
 */
export async function makeProjectManager(
  name: string,
): Promise<{ id: string; email: string; userId: string }> {
  const email = `pm.${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}+${Date.now()}.${Math.floor(
    Math.random() * 1e6,
  )}@demo.local`;
  const user = await prisma.user.create({
    // Not an argon2 hash, so nothing can sign in as this fixture — and it skips the
    // ~50ms a real hash costs, which adds up across every suite that makes a manager.
    data: { email, name, role: 'PROJECT_MANAGER', passwordHash: '!fixture' },
  });
  const pm = await prisma.projectManager.create({ data: { name, email, userId: user.id } });
  return { id: pm.id, email: pm.email, userId: user.id };
}

/** A seeded supplier that actually stocks the given gas — `POST /batches` checks. */
export async function supplierForGas(gasTypeId: string): Promise<string> {
  const link = await prisma.gasSupplier.findFirst({
    where: { gasTypeId },
    include: { supplier: true },
    orderBy: { supplierId: 'asc' },
  });
  if (!link) throw new Error(`no seeded supplier paired with gas ${gasTypeId}`);
  return link.supplierId;
}

/**
 * A real, complete 1×1 JPEG (631 bytes: SOI … EOI), not a stub with the right first
 * three bytes. `services/photo.ts` only checks the magic, but a fixture that is not
 * actually an image would quietly stop testing the thing it looks like it tests the
 * moment that check gets stricter.
 */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIs' +
  'IxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA' +
  'AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk' +
  'M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT' +
  'lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QA' +
  'HwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh' +
  'cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp' +
  'anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk' +
  '5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

/**
 * The batch photo every initialization, transfer and return must carry.
 *
 * Defaults to a successful GPS fix, because that is the ordinary case; pass overrides
 * for the cases that are not (`{ latitude: null, longitude: null, locationError: '…' }`
 * for a phone that could not get one).
 */
export function testPhoto(overrides: Record<string, unknown> = {}) {
  return {
    imageBase64: `data:image/jpeg;base64,${TINY_JPEG_BASE64}`,
    capturedAt: new Date().toISOString(),
    latitude: -26.2041,
    longitude: 28.0473,
    accuracyM: 12,
    locationError: null,
    ...overrides,
  };
}

/**
 * The driver identity every return must carry: the number off the document, and a
 * photograph of the document itself.
 *
 * The image is the same tiny JPEG the batch photo uses — `services/photo.ts` cares
 * that it is a real image and nothing else, and a second fixture would only be a
 * second thing to keep in step.
 */
export function testDriverId(overrides: Record<string, unknown> = {}) {
  return {
    driverIdNumber: '8801015009087',
    driverIdPhoto: testPhoto(),
    ...overrides,
  };
}

/** A 1x1 PNG. `services/signature.ts` checks the magic bytes, not the drawing. */
export const TEST_SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The whole driver sign-off a transfer or a return must carry: who took the
 * cylinders, the number off their document, a photo of it, and their signature.
 *
 * One fixture for both flows, because the two schemas deliberately ask for the same
 * things — see `schemas/driver.ts`. A test about scans or photos spreads this so it
 * fails for the reason it is named after.
 */
export const TEST_DRIVER_PHONE = '082 555 0199';

/**
 * Cage 1 for each gas on a line delivered to stores — what an initialization must name. Read from the database rather than passed in, so a test
 * whose batch mixes stores and site lines does not have to know which is which.
 */
export async function storesCagesFor(
  batchId: string,
  cage = 1,
): Promise<{ gasTypeId: string; cage: number }[]> {
  const rows = await prisma.cylinder.findMany({
    where: { batchId, status: 'IN_STORES', batchLine: { initialDeliveryPoint: 'STORES' } },
    select: { gasTypeId: true },
    distinct: ['gasTypeId'],
  });
  return rows.map((r) => ({ gasTypeId: r.gasTypeId, cage }));
}

/**
 * One cage for every gas in the batch — for a transfer back to stores. Transfers accept
 * a cage for a gas that did not move (the moved set is only known after the claim), so
 * a test that does not care which cage can send this whatever it scanned.
 */
export async function batchGasCages(
  batchId: string,
  cage = 1,
): Promise<{ gasTypeId: string; cage: number }[]> {
  const rows = await prisma.cylinder.findMany({
    where: { batchId },
    select: { gasTypeId: true },
    distinct: ['gasTypeId'],
  });
  return rows.map((r) => ({ gasTypeId: r.gasTypeId, cage }));
}

export function testSignOff(overrides: Record<string, unknown> = {}) {
  return {
    driverName: 'Sipho Ndlovu',
    driverPhone: TEST_DRIVER_PHONE,
    signaturePng: TEST_SIGNATURE,
    ...testDriverId(),
    ...overrides,
  };
}

/**
 * Scan a whole batch in, so it can then be transferred or returned.
 *
 * Every batch needs this now: `POST /transfers` and `POST /returns` refuse an
 * uninitialized batch with 409, because a cylinder whose label was never read back off
 * it cannot honestly be scanned onto a truck. Tests that only care about what happens
 * *after* the batch is live call this once and forget about it.
 */
export async function initializeBatch(
  app: FastifyInstance,
  token: string,
  batchId: string,
  serials: string[],
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/initializations',
    headers: bearer(token),
    payload: {
      batchId,
      clientRequestId: randomUUID(),
      scans: serials.map((serialCode) => ({
        serialCode,
        qrPayload: qrPayloadFor(serialCode),
        scannedAt: new Date().toISOString(),
      })),
      cages: await storesCagesFor(batchId),
      photo: testPhoto(),
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`initializeBatch failed: ${res.statusCode} ${res.body}`);
  }
}
