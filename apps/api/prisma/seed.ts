import 'dotenv/config';
import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Idempotent seed: gas types with prefixes, the supplier catalogue and its gas
 * pairings, and the two people who own this system — as PROJECT_MANAGER logins, each
 * with the manager record batch mail is addressed to, and argon2id hashes computed
 * here. Re-runnable.
 * SerialSequence rows are intentionally NOT seeded — the allocator creates each
 * (prefix, year) lazily via INSERT ... ON CONFLICT.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

/**
 * `active` decides what the gas dropdown offers. The change spec asks for Argon and
 * Nitrogen only — the other four are deactivated rather than deleted, because
 * Cylinder.gasTypeId is a Restrict foreign key and any cylinder ever booked under
 * them still needs its gas to resolve. Re-offering one is an UPDATE, not a migration.
 */
const GAS_TYPES = [
  { name: 'Argon', prefix: 'ARG', active: true },
  { name: 'Nitrogen', prefix: 'NIT', active: true },
  { name: 'Oxygen', prefix: 'OXY', active: false },
  { name: 'CO2', prefix: 'CO2', active: false },
  { name: 'Helium', prefix: 'HEL', active: false },
  { name: 'Acetylene', prefix: 'ACE', active: false },
];

/** Placeholders until the real supplier names arrive — an UPDATE, not a deploy. */
const SUPPLIERS = ['Supplier 1', 'Supplier 2'];

/** Which suppliers stock which gas. Every combination, for now. */
const GAS_SUPPLIERS: Record<string, string[]> = {
  Argon: SUPPLIERS,
  Nitrogen: SUPPLIERS,
};

/**
 * The two real people who run this system, and the only accounts it ships with.
 *
 * Each is a project manager, which is ONE person held in two rows: a `User` with role
 * PROJECT_MANAGER (signs in, runs the admin console) and the `ProjectManager` row it
 * owns (the addressee of QR sheets and delivery notes). There is no separate admin.
 *
 * Emails are stored lower-case. `POST /admin/project-managers` lower-cases what it is
 * given, so seeding a capitalised address would let the same person be added a second
 * time through the console without tripping the unique index.
 *
 * There used to be three `@demo.local` logins here too, kept because the integration
 * suite signed in as them. A real install must not ship publicly-known passwords on
 * accounts nobody owns, so the suite creates its own (`ensureTestUsers` in
 * test/helpers.ts). Everyone else is added through the admin console, by one of these.
 */
const PROJECT_MANAGERS = [
  { name: 'Jacques Viljoen', email: 'jacques.viljoen@gmail.com' },
  { name: 'Tumelo Mashaba', email: 'mashabaindustriesllc@gmail.com' },
];

const DEV_PASSWORD = process.env.SEED_PASSWORD ?? 'gea';

async function main(): Promise<void> {
  const gasTypeIds = new Map<string, string>();
  for (const gt of GAS_TYPES) {
    const row = await prisma.gasType.upsert({
      where: { name: gt.name },
      update: { prefix: gt.prefix, active: gt.active },
      create: { name: gt.name, prefix: gt.prefix, active: gt.active },
    });
    gasTypeIds.set(row.name, row.id);
  }

  const supplierIds = new Map<string, string>();
  for (const name of SUPPLIERS) {
    const row = await prisma.supplier.upsert({
      where: { name },
      update: { active: true },
      create: { name, active: true },
    });
    supplierIds.set(name, row.id);
  }

  for (const [gasName, supplierNames] of Object.entries(GAS_SUPPLIERS)) {
    const gasTypeId = gasTypeIds.get(gasName);
    if (!gasTypeId) continue;
    for (const supplierName of supplierNames) {
      const supplierId = supplierIds.get(supplierName);
      if (!supplierId) continue;
      await prisma.gasSupplier.upsert({
        where: { gasTypeId_supplierId: { gasTypeId, supplierId } },
        update: {},
        create: { gasTypeId, supplierId },
      });
    }
  }

  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
  for (const pm of PROJECT_MANAGERS) {
    const role = 'PROJECT_MANAGER' as const;
    // The login first: the manager row holds the foreign key to it.
    const user = await prisma.user.upsert({
      where: { email: pm.email },
      // The hash is re-applied on update too, so changing SEED_PASSWORD and re-seeding
      // actually changes the password. Without this the update branch silently kept
      // whatever hash was already there and the new value looked like it had no effect.
      update: { name: pm.name, role, active: true, passwordHash },
      create: { email: pm.email, name: pm.name, role, active: true, passwordHash },
    });
    await prisma.projectManager.upsert({
      where: { email: pm.email },
      update: { name: pm.name, userId: user.id, active: true },
      create: { name: pm.name, email: pm.email, userId: user.id },
    });
  }

  // NO demo project. Projects are real work — a fixture one sits in every list and in
  // the project-number search, and the first time someone books a real batch against
  // it by mistake it becomes a real problem. The catalogue (gas types, suppliers,
  // managers, logins) is what a fresh install needs; the projects are the operator's.

  console.log('seed complete:', {
    gasTypes: `${GAS_TYPES.filter((g) => g.active).length} active / ${GAS_TYPES.length}`,
    suppliers: SUPPLIERS,
    projectManagers: PROJECT_MANAGERS.map((p) => `${p.email} (signs in, runs the console)`),
    projects: 'none — created in the app',
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
