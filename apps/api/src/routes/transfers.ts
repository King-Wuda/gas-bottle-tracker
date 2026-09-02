import type { FastifyInstance } from 'fastify';
import {
  createTransferRequestSchema,
  type CreateTransferResponse,
  type ScanRejection,
  type TransferDto,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';
import { preparePhoto } from '../services/photo.js';
import { toPhotoDto, type PhotoRow } from '../services/photoView.js';
import { resolveScans, scanRejection } from '../services/scans.js';

/** Thrown to roll the transaction back when nothing survived validation, so no
 *  orphan Transfer row is left behind for a submission that moved no cylinders. */
class NoValidScansError extends Error {
  constructor(public rejected: ScanRejection[]) {
    super('No scanned cylinder could be transferred');
  }
}

type TransferRow = {
  id: string;
  batchId: string;
  destinationType: 'SITE' | 'STORES';
  destinationSiteId: string | null;
  userId: string;
  projectManagerId: string | null;
  photoOverridden: boolean;
  createdAt: Date;
  destinationSite: { name: string } | null;
  projectManager: { name: string } | null;
  movementEvents: { overridden: boolean; cylinder: { serialCode: string } }[];
  photo: PhotoRow | null;
};

export const transferInclude = {
  destinationSite: { select: { name: true } },
  projectManager: { select: { name: true } },
  movementEvents: {
    select: { overridden: true, cylinder: { select: { serialCode: true } } },
    orderBy: { cylinder: { serialCode: 'asc' } },
  },
  photo: { include: { user: { select: { name: true } } } },
} as const;

const toTransferDto = (t: TransferRow): TransferDto => ({
  id: t.id,
  batchId: t.batchId,
  destinationType: t.destinationType,
  destinationSiteId: t.destinationSiteId,
  destinationSiteName: t.destinationSite?.name ?? null,
  userId: t.userId,
  createdAt: t.createdAt.toISOString(),
  movedSerials: t.movementEvents.map((m) => m.cylinder.serialCode),
  overriddenSerials: t.movementEvents.filter((m) => m.overridden).map((m) => m.cylinder.serialCode),
  projectManagerId: t.projectManagerId,
  projectManagerName: t.projectManager?.name ?? null,
  photo: t.photo ? toPhotoDto(t.photo) : null,
  photoOverridden: t.photoOverridden,
});

/** One row of the atomic claim below. `fromSiteId` is the cylinder's location as
 *  seen under the row lock — i.e. after any concurrent transfer committed. */
interface ClaimedRow {
  id: string;
  serialCode: string;
  fromSiteId: string | null;
}

export async function transferRoutes(app: FastifyInstance): Promise<void> {
  const findByRequestId = (clientRequestId: string) =>
    prisma.transfer.findUnique({ where: { clientRequestId }, include: transferInclude });

  const replayBody = (t: TransferRow): CreateTransferResponse => ({
    transfer: toTransferDto(t),
    // A replay reports no rejections: the ones from the original call were already
    // shown to the user, and re-deriving them now would race against later state.
    rejected: [],
  });

  // Workflow B (server side): validate the scans, move only what was physically
  // scanned, and append one TRANSFER movement event per cylinder.
  app.post(
    '/transfers',
    { preHandler: app.requireRole('TECHNICIAN', 'STORES_MANAGER', 'ADMIN') },
    async (request, reply) => {
      const input = createTransferRequestSchema.parse(request.body);

      const existing = await findByRequestId(input.clientRequestId);
      if (existing) return reply.code(200).send(replayBody(existing));

      // The scan requirement is CRITICAL ENFORCEMENT, so the one exception to it is
      // gated here, before anything else is evaluated. A non-admin who posts
      // overrideSerials is refused outright rather than having them quietly ignored —
      // silently dropping them would let a tampered client believe it moved stock it
      // did not.
      if (input.overrideSerials.length > 0 && request.user.role !== 'ADMIN') {
        return reply.code(403).send({
          error: {
            code: 'OVERRIDE_FORBIDDEN',
            message: 'Only an admin can move a cylinder without scanning it.',
          },
        });
      }

      const batch = await prisma.batch.findUnique({ where: { id: input.batchId } });
      if (!batch) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
      }

      // Nothing in an uninitialized batch can move: its labels have never been read
      // back off the cylinders, so every serial here would be an assertion dressed as
      // a scan. Answered once, up front, rather than as 40 identical per-serial
      // rejections — `resolveScans` still gates it too, as defence in depth for any
      // caller that reaches it another way.
      if (!batch.initializedAt) {
        return reply.code(409).send({
          error: {
            code: 'BATCH_NOT_INITIALIZED',
            message:
              'This batch has not been initialized. Scan it in first (New → Initialize a batch) ' +
              'so its labels are on record before anything moves.',
          },
        });
      }

      // Handing the batch to a different manager, if this move does that. Validated
      // out here so an unknown or deactivated manager fails before any cylinder is
      // locked.
      let newManager: { id: string; email: string } | null = null;
      if (input.projectManagerId && input.projectManagerId !== batch.projectManagerId) {
        const pm = await prisma.projectManager.findUnique({
          where: { id: input.projectManagerId },
        });
        if (!pm || !pm.active) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_PROJECT_MANAGER',
              message: 'Unknown or deactivated project manager',
            },
          });
        }
        newManager = { id: pm.id, email: pm.email };
      }

      const destSiteId = input.destination.type === 'SITE' ? input.destination.siteId : null;
      if (destSiteId) {
        const site = await prisma.site.findUnique({ where: { id: destSiteId } });
        // Workflow B is "relocation between project sites or back to stores" — a
        // destination in someone else's project would silently move a cylinder off
        // its own contract and break rental accountability.
        if (!site || site.projectId !== batch.projectId) {
          return reply.code(400).send({
            error: {
              code: 'INVALID_DESTINATION',
              message: 'Destination site does not belong to this batch’s project',
            },
          });
        }
      }

      const userId = request.user.sub;
      const newStatus = destSiteId ? 'DEPLOYED' : 'IN_STORES';

      // Decode and persist the photo BEFORE the transaction — filesystem IO, so it
      // must not run under a row lock. Same ordering as the driver's signature in
      // routes/returns.ts.
      const prepared = await preparePhoto({
        photo: input.photo,
        photoOverride: input.photoOverride,
        role: request.user.role,
        userId,
        batchId: input.batchId,
        clientRequestId: input.clientRequestId,
        verb: 'transfer',
      });
      if (!prepared.ok) {
        return reply
          .code(prepared.status)
          .send({ error: { code: prepared.code, message: prepared.message } });
      }

      let result: { transferId: string; rejected: ScanRejection[] };
      try {
        result = await prisma.$transaction(
          async (tx) => {
            // Claim the idempotency key FIRST, before evaluating a single scan.
            // A concurrent duplicate blocks right here on the unique index until we
            // commit or abort. That ordering is load-bearing: evaluating scans first
            // let a retry read the state its own original had already produced, see
            // every cylinder as ALREADY_AT_DESTINATION, and 422 — instead of ever
            // reaching the P2002 that routes it to the replay path. An outbox retry
            // that gets a hard refusal is an outbox retry that never clears.
            const transfer = await tx.transfer.create({
              data: {
                batchId: input.batchId,
                destinationType: input.destination.type,
                destinationSiteId: destSiteId,
                userId,
                projectManagerId: newManager?.id ?? null,
                photoOverridden: prepared.overridden,
                clientRequestId: input.clientRequestId,
              },
            });

            if (prepared.columns) {
              await tx.batchPhoto.create({
                data: { ...prepared.columns, transferId: transfer.id },
              });
            }

            const { accepted, rejected } = await resolveScans(
              tx,
              input.batchId,
              input.scans,
              input.overrideSerials,
            );

            const movable = accepted.filter((c) => {
              if (c.currentSiteId === destSiteId) {
                rejected.push(
                  scanRejection(
                    c.serialCode,
                    'ALREADY_AT_DESTINATION',
                    destSiteId
                      ? 'This cylinder is already at the destination site.'
                      : 'This cylinder is already at stores.',
                  ),
                );
                return false;
              }
              return true;
            });
            if (movable.length === 0) throw new NoValidScansError(rejected);

            // THE CLAIM. Everything above read state; this single statement is what
            // actually decides who moves. The predicate lives in SQL — re-checked by
            // Postgres under the row lock — so a cylinder returned or transferred
            // between our read and this write is skipped rather than moved twice.
            // `l."currentSiteId"` is read through FOR UPDATE, so it is the location
            // after any concurrent commit, not our stale snapshot: the audit trail's
            // fromSiteId cannot be a fabricated origin.
            const ids = movable.map((c) => c.id);
            const claimed = await tx.$queryRaw<ClaimedRow[]>`
              WITH locked AS (
                SELECT "id", "serialCode", "currentSiteId"
                FROM "Cylinder"
                WHERE "id" IN (${Prisma.join(ids)})
                  AND "batchId" = ${input.batchId}
                  AND "status" <> 'RETURNED'
                  AND "currentSiteId" IS DISTINCT FROM ${destSiteId}::text
                ORDER BY "id"
                FOR UPDATE
              )
              UPDATE "Cylinder" AS c
              SET "status" = ${newStatus}::"CylinderStatus",
                  "currentSiteId" = ${destSiteId}::text,
                  "updatedAt" = now()
              FROM locked AS l
              WHERE c."id" = l."id"
              RETURNING c."id", c."serialCode", l."currentSiteId" AS "fromSiteId"
            `;

            const claimedIds = new Set(claimed.map((c) => c.id));
            for (const c of movable) {
              if (!claimedIds.has(c.id)) {
                rejected.push(
                  scanRejection(
                    c.serialCode,
                    'CONFLICT',
                    'Another user moved or returned this cylinder first. Re-scan to see its current location.',
                  ),
                );
              }
            }
            if (claimed.length === 0) throw new NoValidScansError(rejected);

            const bySerial = new Map(movable.map((c) => [c.serialCode, c]));
            await tx.movementEvent.createMany({
              data: claimed.map((c) => ({
                cylinderId: c.id,
                type: 'TRANSFER' as const,
                fromSiteId: c.fromSiteId,
                toSiteId: destSiteId,
                userId,
                transferId: transfer.id,
                deviceAt: bySerial.get(c.serialCode)?.scannedAt ?? new Date(),
                overridden: bySerial.get(c.serialCode)?.overridden ?? false,
              })),
            });

            // Stamp the batch's first movement. Conditional in the WHERE, not in an
            // `if`: two transfers of the same batch racing must not have the second
            // overwrite the first one's timestamp, and `updateMany` matching zero
            // rows is exactly the right outcome for the loser. The value is the
            // Transfer's own DB-assigned createdAt, so the stamp and the record that
            // proves it can never disagree.
            await tx.batch.updateMany({
              where: { id: input.batchId, transferredAt: null },
              data: { transferredAt: transfer.createdAt },
            });

            // Hand the batch over, if this move does that. Unconditional (unlike the
            // stamp above): reassignment is an explicit instruction, so the last one
            // submitted is the one that should stick. The snapshot email moves with
            // it — a deliberate reassignment IS the redirection being asked for,
            // which is exactly what distinguishes it from correcting a typo in the
            // old manager's own address.
            if (newManager) {
              await tx.batch.update({
                where: { id: input.batchId },
                data: {
                  projectManagerId: newManager.id,
                  projectManagerEmail: newManager.email,
                },
              });
            }

            return { transferId: transfer.id, rejected };
          },
          { timeout: 20_000, maxWait: 10_000 },
        );
      } catch (err) {
        if (err instanceof NoValidScansError) {
          return reply.code(422).send({
            error: {
              code: 'NO_VALID_SCANS',
              message: 'No scanned cylinder could be transferred.',
              details: { rejected: err.rejected },
            },
          });
        }
        // Two devices replaying the same queued transfer at once: both missed the
        // findUnique above, one lost the unique index. That is a replay, not a
        // conflict — return what the winner created (see the M2 batches precedent).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const winner = await findByRequestId(input.clientRequestId);
          if (winner) return reply.code(200).send(replayBody(winner));
        }
        throw err;
      }

      const full = await prisma.transfer.findUniqueOrThrow({
        where: { id: result.transferId },
        include: transferInclude,
      });
      const body: CreateTransferResponse = {
        transfer: toTransferDto(full),
        rejected: result.rejected,
      };
      return reply.code(201).send(body);
    },
  );
}
