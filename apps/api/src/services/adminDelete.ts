/**
 * Destructive admin deletes, and the counts that let someone see what they are about
 * to destroy BEFORE they confirm it.
 *
 * Everything else in this codebase treats the movement log as append-only evidence —
 * every FK into it is `onDelete: Restrict` precisely so that nothing can quietly erase
 * the trail. This module is the one deliberate exception, and it exists because
 * "remove this client" has to actually mean it: a depot that stops working with
 * McCains wants McCains gone, not an inactive row that still fills the pickers.
 *
 * Two rules make that defensible rather than reckless:
 *
 *  1. **Nothing deletes without a preview.** Every entry point has a matching
 *     `*Impact()` that counts what would go, and the screens show those numbers in the
 *     confirmation. An admin who deletes 400 batches did so having been told it was
 *     400 batches.
 *  2. **The blobs go too.** Signatures, ID photographs, batch photos and delivery-note
 *     PDFs are removed along with the rows that point at them. Dropping only the rows
 *     would leave the evidence sitting on disk under a key nothing references —
 *     neither retrievable through the app nor actually deleted, which is the worst of
 *     both.
 *
 * Order is not a matter of taste here. Every delete below runs before the thing it
 * points at, because the FKs really are Restrict and the database will refuse
 * otherwise — which is the behaviour we want everywhere except this file.
 */
import type { FastifyBaseLogger } from 'fastify';
import { prisma, Prisma } from '../db.js';
import { deleteFiles } from './storage.js';

/** What a delete would destroy. Every number is a row count, not an estimate. */
export type DeletionImpact = {
  projects: number;
  sites: number;
  batches: number;
  cylinders: number;
  movementEvents: number;
  transfers: number;
  returns: number;
  initializations: number;
  photos: number;
  amendments: number;
  emails: number;
  /** Signature PNGs, ID photographs, batch photos and delivery-note PDFs. */
  files: number;
};

const EMPTY: DeletionImpact = {
  projects: 0,
  sites: 0,
  batches: 0,
  cylinders: 0,
  movementEvents: 0,
  transfers: 0,
  returns: 0,
  initializations: 0,
  photos: 0,
  amendments: 0,
  emails: 0,
  files: 0,
};

const add = (a: DeletionImpact, b: Partial<DeletionImpact>): DeletionImpact => ({
  projects: a.projects + (b.projects ?? 0),
  sites: a.sites + (b.sites ?? 0),
  batches: a.batches + (b.batches ?? 0),
  cylinders: a.cylinders + (b.cylinders ?? 0),
  movementEvents: a.movementEvents + (b.movementEvents ?? 0),
  transfers: a.transfers + (b.transfers ?? 0),
  returns: a.returns + (b.returns ?? 0),
  initializations: a.initializations + (b.initializations ?? 0),
  photos: a.photos + (b.photos ?? 0),
  amendments: a.amendments + (b.amendments ?? 0),
  emails: a.emails + (b.emails ?? 0),
  files: a.files + (b.files ?? 0),
});

/** True when anything at all would be destroyed — drives "this is safe" in the UI. */
export const isDestructive = (i: DeletionImpact): boolean =>
  i.batches + i.cylinders + i.movementEvents + i.transfers + i.returns + i.photos > 0;

/**
 * A big cascade is many statements, and Prisma's default interactive-transaction
 * budget is five seconds. A client with a few hundred batches will exceed that on a
 * cold connection, and a half-applied delete is precisely the outcome the transaction
 * is here to prevent.
 */
const TX_OPTIONS = { timeout: 120_000, maxWait: 15_000 } as const;

type Tx = Prisma.TransactionClient;

// --------------------------------------------------------------- impact counting

/** Batch ids belonging to a project, a site, or an explicit list. */
async function batchIdsFor(where: Prisma.BatchWhereInput): Promise<string[]> {
  const rows = await prisma.batch.findMany({ where, select: { id: true } });
  return rows.map((b) => b.id);
}

/**
 * Count everything hanging off a set of batches.
 *
 * Deliberately counted rather than derived from the batch count: a batch with five
 * cylinders and one with five hundred are the same row here, and the number that
 * actually tells an admin whether to go ahead is the cylinder count.
 */
export async function impactOfBatches(batchIds: string[]): Promise<DeletionImpact> {
  if (batchIds.length === 0) return EMPTY;
  const batch = { in: batchIds };

  const cylinders = await prisma.cylinder.findMany({
    where: { batchId: batch },
    select: { id: true },
  });
  const cylinderIds = cylinders.map((c) => c.id);

  const [movementEvents, transfers, returns, initializations, photos, amendments, emails] =
    await Promise.all([
      cylinderIds.length
        ? prisma.movementEvent.count({ where: { cylinderId: { in: cylinderIds } } })
        : 0,
      prisma.transfer.count({ where: { batchId: batch } }),
      prisma.returnRecord.count({ where: { batchId: batch } }),
      prisma.batchInitialization.count({ where: { batchId: batch } }),
      prisma.batchPhoto.count({ where: { batchId: batch } }),
      prisma.batchAmendment.count({ where: { batchId: batch } }),
      countEmailsFor(prisma, batchIds),
    ]);

  return add(EMPTY, {
    batches: batchIds.length,
    cylinders: cylinderIds.length,
    movementEvents,
    transfers,
    returns,
    initializations,
    photos,
    amendments,
    emails,
    files: await countFilesFor(batchIds),
  });
}

/** How many stored blobs these batches own. Counted the same way they are deleted. */
async function countFilesFor(batchIds: string[]): Promise<number> {
  return (await filePathsFor(prisma, batchIds)).length;
}

/**
 * The outbox rows for a set of batches.
 *
 * `OutboundEmail` has no foreign key to `Batch` — it carries a JSON render context
 * instead, so one table can serve QR sheets and delivery notes alike. Prisma's JSON
 * filter can test one path against one value but not against a LIST, so matching many
 * batches at once drops to SQL rather than building an OR with a clause per batch.
 */
async function countEmailsFor(db: Tx | typeof prisma, batchIds: string[]): Promise<number> {
  if (batchIds.length === 0) return 0;
  const rows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "OutboundEmail"
    WHERE "payload"->>'batchId' = ANY(${batchIds})
  `;
  return Number(rows[0]?.count ?? 0);
}

async function emailAttachmentsFor(
  db: Tx | typeof prisma,
  batchIds: string[],
): Promise<{ attachmentPaths: string[] }[]> {
  if (batchIds.length === 0) return [];
  return db.$queryRaw<{ attachmentPaths: string[] }[]>`
    SELECT "attachmentPaths"
    FROM "OutboundEmail"
    WHERE "payload"->>'batchId' = ANY(${batchIds})
  `;
}

/**
 * Every stored-blob key these batches own.
 *
 * Gathered from the rows BEFORE they are deleted, because afterwards there is nothing
 * left to ask. Read through the same client as the caller so it can run inside the
 * transaction that is about to drop them.
 */
async function filePathsFor(db: Tx | typeof prisma, batchIds: string[]): Promise<string[]> {
  if (batchIds.length === 0) return [];
  const batch = { in: batchIds };

  const [photos, returns, transfers, emails] = await Promise.all([
    db.batchPhoto.findMany({ where: { batchId: batch }, select: { path: true } }),
    db.returnRecord.findMany({
      where: { batchId: batch },
      select: { signaturePath: true, driverIdPath: true, deliveryNotePath: true },
    }),
    db.transfer.findMany({
      where: { batchId: batch },
      select: { signaturePath: true, driverIdPath: true },
    }),
    emailAttachmentsFor(db, batchIds),
  ]);

  return [
    ...photos.map((p) => p.path),
    ...returns.flatMap((r) => [r.signaturePath, r.driverIdPath, r.deliveryNotePath]),
    ...transfers.flatMap((t) => [t.signaturePath, t.driverIdPath]),
    ...emails.flatMap((e) => e.attachmentPaths),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * One job for a client: its batches and nothing else.
 *
 * Sites are NOT counted here, and that is the point of the restructure — they belong
 * to the client, are shared by every project for them, and outlive any one job.
 */
export async function projectImpact(projectId: string): Promise<DeletionImpact> {
  return add(await impactOfBatches(await batchIdsFor({ projectId })), { projects: 1 });
}

/** A client, every job for them, and every place they take delivery at. */
export async function clientImpact(clientId: string): Promise<DeletionImpact> {
  const [projects, sites, ids] = await Promise.all([
    prisma.project.count({ where: { clientId } }),
    prisma.site.count({ where: { clientId } }),
    batchIdsFor({ project: { clientId } }),
  ]);
  return add(await impactOfBatches(ids), { projects, sites });
}

export async function siteImpact(siteId: string): Promise<DeletionImpact> {
  return add(await impactOfBatches(await batchIdsFor({ siteId })), { sites: 1 });
}

export async function gasTypeImpact(gasTypeId: string): Promise<DeletionImpact> {
  const lines = await prisma.batchLine.findMany({
    where: { gasTypeId },
    select: { batchId: true },
  });
  return impactOfBatches([...new Set(lines.map((l) => l.batchId))]);
}

export async function supplierImpact(supplierId: string): Promise<DeletionImpact> {
  const lines = await prisma.batchLine.findMany({
    where: { supplierId },
    select: { batchId: true },
  });
  return impactOfBatches([...new Set(lines.map((l) => l.batchId))]);
}

// ------------------------------------------------------------------- the cascade

/**
 * Drop a set of batches and everything that hangs off them.
 *
 * The order is dictated by the Restrict FKs and is the whole substance of this
 * function: photos reference the transfer/return/initialization they evidence, and
 * movement events reference all three plus the cylinder — so both have to go before
 * anything they point at, and cylinders before the lines they were allocated from.
 *
 * Returns the blob keys it orphaned, for the caller to remove once the transaction
 * commits. Deleting files inside the transaction would delete them even on a rollback.
 */
async function purgeBatches(tx: Tx, batchIds: string[]): Promise<string[]> {
  if (batchIds.length === 0) return [];
  const batch = { in: batchIds };

  const paths = await filePathsFor(tx, batchIds);

  const cylinders = await tx.cylinder.findMany({ where: { batchId: batch }, select: { id: true } });
  const cylinderIds = cylinders.map((c) => c.id);

  // Photos first: each one points at the event it evidences.
  await tx.batchPhoto.deleteMany({ where: { batchId: batch } });
  // Then the movement log, which points at the cylinder AND at its event.
  if (cylinderIds.length > 0) {
    await tx.movementEvent.deleteMany({ where: { cylinderId: { in: cylinderIds } } });
  }
  // Now the events themselves are unreferenced.
  await tx.transfer.deleteMany({ where: { batchId: batch } });
  await tx.returnRecord.deleteMany({ where: { batchId: batch } });
  await tx.batchInitialization.deleteMany({ where: { batchId: batch } });
  // Cylinders before lines: a cylinder is allocated from a line.
  await tx.cylinder.deleteMany({ where: { batchId: batch } });
  await tx.batchLine.deleteMany({ where: { batchId: batch } });
  await tx.batchAmendment.deleteMany({ where: { batchId: batch } });
  // The outbox has no FK to Batch — it carries a render context — so it is matched on
  // the payload, exactly as the delivery-status lookup does.
  await tx.$executeRaw`DELETE FROM "OutboundEmail" WHERE "payload"->>'batchId' = ANY(${batchIds})`;
  await tx.batch.deleteMany({ where: { id: batch } });

  return paths;
}

/**
 * Deal with records that outlive a location.
 *
 * A location is not only referenced by its own batches. Within one client, cylinders
 * move freely between sites, so a Delmas batch can be sitting at Cape Town when Cape
 * Town is deleted — and that batch survives, because it belongs to Delmas.
 *
 * Two kinds of leftover, handled differently, and the schema's CHECK constraints are
 * what decide which is which:
 *
 *  - **Cylinders** go back to Stores. `Cylinder_deployed_has_site` says a DEPLOYED
 *    cylinder must have a site, so this is status AND location or the write is
 *    rejected. Terminal RETURNED cylinders are left alone: putting them back in stock
 *    would return cylinders to the yard that came home months ago.
 *  - **Transfers that delivered TO the location cannot survive it.**
 *    `Transfer_site_destination_has_site` says a SITE-bound transfer must name one, so
 *    the alternatives are to delete the transfer or to rewrite it as having gone to
 *    Stores. The second is a lie about where the cylinders went, so the record goes,
 *    with the movement events and photo that evidence it.
 *
 * Movement events that merely NAME the site go too, for the same reason: NULL there
 * does not mean "somewhere gone", it means Stores.
 *
 * Returns the blob keys it orphaned, for the caller to remove after the commit.
 */
async function detachSurvivorsFromSites(tx: Tx, siteIds: string[]): Promise<string[]> {
  const site = { in: siteIds };

  await tx.cylinder.updateMany({
    where: { currentSiteId: site, status: 'DEPLOYED' },
    data: { currentSiteId: null, status: 'IN_STORES' },
  });
  await tx.cylinder.updateMany({ where: { currentSiteId: site }, data: { currentSiteId: null } });

  const doomed = await tx.transfer.findMany({
    where: { destinationSiteId: site },
    select: { id: true, signaturePath: true, driverIdPath: true },
  });
  const transferIds = doomed.map((t) => t.id);
  const paths = doomed
    .flatMap((t) => [t.signaturePath, t.driverIdPath])
    .filter((p): p is string => typeof p === 'string' && p.length > 0);

  if (transferIds.length > 0) {
    const photos = await tx.batchPhoto.findMany({
      where: { transferId: { in: transferIds } },
      select: { path: true },
    });
    paths.push(...photos.map((p) => p.path));
    await tx.batchPhoto.deleteMany({ where: { transferId: { in: transferIds } } });
    await tx.movementEvent.deleteMany({ where: { transferId: { in: transferIds } } });
    await tx.transfer.deleteMany({ where: { id: { in: transferIds } } });
  }

  await tx.movementEvent.deleteMany({ where: { OR: [{ fromSiteId: site }, { toSiteId: site }] } });
  return paths;
}

/** Remove one location, its batches, and everything they hold. */
export async function deleteSite(siteId: string, log?: FastifyBaseLogger): Promise<DeletionImpact> {
  const impact = await siteImpact(siteId);
  const paths = await prisma.$transaction(async (tx) => {
    const ids = (await tx.batch.findMany({ where: { siteId }, select: { id: true } })).map(
      (b) => b.id,
    );
    const orphaned = await purgeBatches(tx, ids);
    orphaned.push(...(await detachSurvivorsFromSites(tx, [siteId])));
    await tx.site.delete({ where: { id: siteId } });
    return orphaned;
  }, TX_OPTIONS);

  const removed = await deleteFiles(paths);
  log?.warn({ siteId, impact, filesRemoved: removed }, 'admin deleted a location');
  return impact;
}

/** Remove one job and its deliveries. The client and its sites are left alone. */
export async function deleteProject(
  projectId: string,
  log?: FastifyBaseLogger,
): Promise<DeletionImpact> {
  const impact = await projectImpact(projectId);
  const paths = await prisma.$transaction(async (tx) => {
    const ids = (await tx.batch.findMany({ where: { projectId }, select: { id: true } })).map(
      (b) => b.id,
    );
    const orphaned = await purgeBatches(tx, ids);
    await tx.project.delete({ where: { id: projectId } });
    return orphaned;
  }, TX_OPTIONS);

  const removed = await deleteFiles(paths);
  log?.warn({ projectId, impact, filesRemoved: removed }, 'admin deleted a project');
  return impact;
}

/** Remove a client, every job for them, and every place they take delivery at. */
export async function deleteClient(
  clientId: string,
  log?: FastifyBaseLogger,
): Promise<DeletionImpact> {
  const impact = await clientImpact(clientId);
  const paths = await prisma.$transaction(async (tx) => {
    const ids = (
      await tx.batch.findMany({ where: { project: { clientId } }, select: { id: true } })
    ).map((b) => b.id);
    const orphaned = await purgeBatches(tx, ids);
    await tx.project.deleteMany({ where: { clientId } });

    const siteIds = (await tx.site.findMany({ where: { clientId }, select: { id: true } })).map(
      (s) => s.id,
    );
    if (siteIds.length > 0) {
      orphaned.push(...(await detachSurvivorsFromSites(tx, siteIds)));
      await tx.site.deleteMany({ where: { id: { in: siteIds } } });
    }
    await tx.client.delete({ where: { id: clientId } });
    return orphaned;
  }, TX_OPTIONS);

  const removed = await deleteFiles(paths);
  log?.warn({ clientId, impact, filesRemoved: removed }, 'admin deleted a client');
  return impact;
}

/**
 * Remove every location of a client but keep the client itself.
 *
 * Separate from `deleteProject` because "this client moved sites" and "we are done
 * with this client" are different decisions, and the second one is the one that should
 * take the client's own record with it.
 */
export async function deleteAllSitesOfClient(
  clientId: string,
  log?: FastifyBaseLogger,
): Promise<DeletionImpact> {
  const siteIds = (await prisma.site.findMany({ where: { clientId }, select: { id: true } })).map(
    (s) => s.id,
  );
  if (siteIds.length === 0) return EMPTY;

  const impact = add(await impactOfBatches(await batchIdsFor({ siteId: { in: siteIds } })), {
    sites: siteIds.length,
  });
  const paths = await prisma.$transaction(async (tx) => {
    const ids = (
      await tx.batch.findMany({ where: { siteId: { in: siteIds } }, select: { id: true } })
    ).map((b) => b.id);
    const orphaned = await purgeBatches(tx, ids);
    orphaned.push(...(await detachSurvivorsFromSites(tx, siteIds)));
    await tx.site.deleteMany({ where: { id: { in: siteIds } } });
    return orphaned;
  }, TX_OPTIONS);

  const removed = await deleteFiles(paths);
  log?.warn(
    { clientId, impact, filesRemoved: removed },
    'admin deleted every location of a client',
  );
  return impact;
}

/**
 * Remove a gas, every pairing that offers it, and every batch line that used it.
 *
 * A batch can carry several gases, and the rule here is the blunt one: every batch
 * that contains this gas is deleted, including the argon lines sitting next to the
 * nitrogen. Stripping the line out instead would leave a batch whose serial range has
 * gaps in it and whose QR sheet no longer matches the labels physically stuck to the
 * cylinders — a record that contradicts the objects it describes. The confirmation
 * shows the batch count before any of this runs.
 */
export async function deleteGasType(
  gasTypeId: string,
  log?: FastifyBaseLogger,
): Promise<DeletionImpact> {
  const impact = await gasTypeImpact(gasTypeId);
  const paths = await prisma.$transaction(async (tx) => {
    const touched = [
      ...new Set(
        (await tx.batchLine.findMany({ where: { gasTypeId }, select: { batchId: true } })).map(
          (l) => l.batchId,
        ),
      ),
    ];
    const orphaned = await purgeBatches(tx, touched);
    await tx.gasSupplier.deleteMany({ where: { gasTypeId } });
    // Serial counters are keyed by the gas's PREFIX, not its id — so they have to be
    // looked up through it. Dropping them matters: re-adding a gas on the same prefix
    // would otherwise resume numbering where the deleted one left off, handing out
    // serials that look like they belong to batches nobody can find any more.
    const gas = await tx.gasType.findUniqueOrThrow({ where: { id: gasTypeId } });
    await tx.serialSequence.deleteMany({ where: { prefix: gas.prefix } });
    await tx.gasType.delete({ where: { id: gasTypeId } });
    return orphaned;
  }, TX_OPTIONS);

  const removed = await deleteFiles(paths);
  log?.warn({ gasTypeId, impact, filesRemoved: removed }, 'admin deleted a gas type');
  return impact;
}

/** Remove a supplier, its pairings, and every batch that was sourced from it. */
export async function deleteSupplier(
  supplierId: string,
  log?: FastifyBaseLogger,
): Promise<DeletionImpact> {
  const impact = await supplierImpact(supplierId);
  const paths = await prisma.$transaction(async (tx) => {
    const touched = [
      ...new Set(
        (await tx.batchLine.findMany({ where: { supplierId }, select: { batchId: true } })).map(
          (l) => l.batchId,
        ),
      ),
    ];
    const orphaned = await purgeBatches(tx, touched);
    await tx.gasSupplier.deleteMany({ where: { supplierId } });
    await tx.supplier.delete({ where: { id: supplierId } });
    return orphaned;
  }, TX_OPTIONS);

  const removed = await deleteFiles(paths);
  log?.warn({ supplierId, impact, filesRemoved: removed }, 'admin deleted a supplier');
  return impact;
}
