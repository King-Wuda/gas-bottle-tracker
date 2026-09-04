import 'dotenv/config';
import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Idempotent seed: gas types with prefixes, the supplier catalogue and its gas
 * pairings, and the two people who own this system — as project managers (who receive
 * batch mail) and as ADMIN logins, with argon2id hashes computed here. Re-runnable.
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
 * The two real people who run this system.
 *
 * They exist TWICE, on purpose, because the schema models two different things and
 * they happen to be both:
 *  - a `ProjectManager` row — the addressee of QR sheets and delivery notes;
 *  - a `User` row with role ADMIN — an account that signs in and runs the console.
 *
 * Emails are stored lower-case. `POST /admin/project-managers` lower-cases what it is
 * given, so seeding a capitalised address would let the same person be added a second
 * time through the console without tripping the unique index.
 */
const OWNERS = [
  { name: 'Jacques Viljoen', email: 'jacques.viljoen@gmail.com' },
  { name: 'Tumelo Mashaba', email: 'mashabaindustriesllc@gmail.com' },
];

/** Recipients of QR sheets and delivery notes. Not app logins — see the schema. */
const PROJECT_MANAGERS = OWNERS;

/**
 * The only accounts this system ships with.
 *
 * There were three `@demo.local` logins here — one per role — kept because the
 * integration suite signed in as them. They are gone: a seed is what a real install
 * starts as, and a real install must not come with three publicly-known passwords on
 * accounts nobody owns. The suite now creates its own accounts (`ensureTestUsers` in
 * test/helpers.ts), which is where test fixtures belonged in the first place.
 *
 * Everyone else is added through the admin console, by one of these two.
 */
const USERS = OWNERS.map((o) => ({ email: o.email, name: o.name, role: 'ADMIN' as const }));

const DEV_PASSWORD = process.env.SEED_PASSWORD ?? 'password';

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

  for (const pm of PROJECT_MANAGERS) {
    await prisma.projectManager.upsert({
      where: { email: pm.email },
      update: { name: pm.name },
      create: { name: pm.name, email: pm.email },
    });
  }

  const passwordHash = await argon2.hash(DEV_PASSWORD, { type: argon2.argon2id });
  for (const u of USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      // The hash is re-applied on update too, so changing SEED_PASSWORD and re-seeding
      // actually changes the password. Without this the update branch silently kept
      // whatever hash was already there and the new value looked like it had no effect.
      update: { name: u.name, role: u.role, active: true, passwordHash },
      create: { email: u.email, name: u.name, role: u.role, active: true, passwordHash },
    });
  }

  // NO demo project. Projects are real work — a fixture one sits in every list and in
  // the project-number search, and the first time someone books a real batch against
  // it by mistake it becomes a real problem. The catalogue (gas types, suppliers,
  // managers, logins) is what a fresh install needs; the projects are the operator's.

  console.log('seed complete:', {
    gasTypes: `${GAS_TYPES.filter((g) => g.active).length} active / ${GAS_TYPES.length}`,
    suppliers: SUPPLIERS,
    projectManagers: PROJECT_MANAGERS.map((p) => p.email),
    users: USERS.map((u) => `${u.email} (${u.role})`),
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
