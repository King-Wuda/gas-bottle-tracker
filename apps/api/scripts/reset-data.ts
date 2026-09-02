/**
 * Wipe the operational data and leave a clean install: catalogue + logins, nothing else.
 *
 * This is NOT `prisma migrate reset` — the schema and the migration history are left
 * completely alone. It empties the tables that hold *work* (batches, cylinders, the
 * movement log, projects, sites) and the rows that accumulate as test residue, then
 * hands over to `prisma/seed.ts` to put the catalogue back.
 *
 * Why a script rather than a handful of DELETEs typed at psql: the delete order is
 * load-bearing. Every foreign key in this schema is `Restrict`, so a wrong order does
 * not cascade — it fails halfway and leaves the database in a state nobody planned.
 * Written down once, it is reviewable and repeatable.
 *
 *   npm run -w @gct/api reset:data -- --yes
 *
 * Refuses to run without `--yes`, and refuses outright if NODE_ENV=production.
 */
import { prisma } from '../src/db.js';

/** Suppliers minted by the integration suite, e.g. "After 1788257088255.824280". */
const TEST_SUPPLIER_RE = /^(After|Before|Lonely|Orphan|Renamed) \d/;

async function main(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.error(
      'reset-data: refusing to run without --yes.\n' +
        'This permanently deletes every batch, cylinder, movement event, project and site.',
    );
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('reset-data: refusing to run with NODE_ENV=production.');
    process.exit(1);
  }

  const before = await counts();

  // Order matters: children before parents, because every FK here is Restrict.
  await prisma.$transaction([
    prisma.batchAmendment.deleteMany(),
    prisma.movementEvent.deleteMany(),
    prisma.returnRecord.deleteMany(),
    prisma.transfer.deleteMany(),
    prisma.cylinder.deleteMany(),
    prisma.batchLine.deleteMany(),
    prisma.batch.deleteMany(),
    prisma.outboundEmail.deleteMany(),
    // The serial allocator's counters. Cleared with the cylinders they numbered, so a
    // fresh install starts at NIT26-001 rather than continuing from whatever the last
    // test run reached.
    prisma.serialSequence.deleteMany(),
    prisma.site.deleteMany(),
    prisma.project.deleteMany(),
    // Recreated by the seed. Safe now that no project or batch points at one.
    prisma.projectManager.deleteMany(),
  ]);

  // Test-residue suppliers, and the gas pairings that hold them in place. The seed's
  // own two are matched by name and survive.
  const junk = await prisma.supplier.findMany({ select: { id: true, name: true } });
  const junkIds = junk.filter((s) => TEST_SUPPLIER_RE.test(s.name)).map((s) => s.id);
  if (junkIds.length > 0) {
    await prisma.$transaction([
      prisma.gasSupplier.deleteMany({ where: { supplierId: { in: junkIds } } }),
      prisma.supplier.deleteMany({ where: { id: { in: junkIds } } }),
    ]);
  }

  // Accounts the suite created. The seed's own are restored by the seed itself, so
  // anything it does not know about is residue.
  await prisma.user.deleteMany({
    where: {
      email: { endsWith: '@demo.local' },
      NOT: {
        email: { in: ['technician@demo.local', 'stores@demo.local', 'admin@demo.local'] },
      },
    },
  });

  const after = await counts();
  console.table(
    Object.keys(before).map((k) => ({
      table: k,
      before: before[k as keyof typeof before],
      after: after[k as keyof typeof after],
    })),
  );
  console.log('\nreset-data complete. Run `npm run -w @gct/api db:seed` to restore the catalogue.');
}

async function counts() {
  const [batches, cylinders, movements, projects, sites, pms, suppliers, users, serials] =
    await Promise.all([
      prisma.batch.count(),
      prisma.cylinder.count(),
      prisma.movementEvent.count(),
      prisma.project.count(),
      prisma.site.count(),
      prisma.projectManager.count(),
      prisma.supplier.count(),
      prisma.user.count(),
      prisma.serialSequence.count(),
    ]);
  return { batches, cylinders, movements, projects, sites, pms, suppliers, users, serials };
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
