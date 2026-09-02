import type { FastifyInstance } from 'fastify';
import {
  createInitializationRequestSchema,
  type CreateInitializationResponse,
  type InitializationDto,
  type ScanRejection,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';
import { toPhotoDto, type PhotoRow } from '../services/photoView.js';
import { preparePhoto } from '../services/photo.js';
import { resolveScans } from '../services/scans.js';

/**
 * Workflow A2 (server side) — the first scan.
 *
 * Creating a batch allocates serials and mails a QR sheet. It does not put a sticker
 * on a cylinder. This route records the moment somebody did: every label read back off
 * the cylinder it was stuck to, at the place the batch was created, with a photo of
 * the assembled batch.
 *
 * ## Why this one is all-or-nothing
 *
 * Transfers and returns accept a subset — 3 of 7 cylinders genuinely can move while 4
 * stay behind. Initialization cannot, because it is a claim about the batch as a unit.
 * Accepting a partial one would leave the system unable to distinguish "cylinder 4 has
 * no label on it" from "cylinder 4 was not scanned today", which is the exact
 * ambiguity the step exists to resolve. So a submission that does not account for
 * every cylinder is refused, and told which ones it missed.
 *
 * ## Why it does not move anything
 *
 * The cylinders are already where the batch put them. Initialization changes no
 * location and no status; it stamps `Batch.initializedAt` and writes one INITIALIZE
 * movement event per cylinder, whose from/to are the cylinder's own current position.
 * That keeps the movement log a complete record of every time a cylinder was seen,
 * rather than only of the times it went somewhere.
 */

/** Rolls the transaction back when the scan set does not cover the whole batch. */
class IncompleteInitializationError extends Error {
  constructor(public missing: string[]) {
    super('Initialization does not cover every cylinder in the batch');
  }
}

type InitializationRow = {
  id: string;
  batchId: string;
  userId: string;
  photoOverridden: boolean;
  createdAt: Date;
  movementEvents: { overridden: boolean; cylinder: { serialCode: string } }[];
  photo: PhotoRow | null;
};

export const initializationInclude = {
  movementEvents: {
    select: { overridden: true, cylinder: { select: { serialCode: true } } },
    orderBy: { cylinder: { serialCode: 'asc' } },
  },
  photo: { include: { user: { select: { name: true } } } },
} as const;

export const toInitializationDto = (i: InitializationRow): InitializationDto => ({
  id: i.id,
  batchId: i.batchId,
  userId: i.userId,
  createdAt: i.createdAt.toISOString(),
  initializedSerials: i.movementEvents.map((m) => m.cylinder.serialCode),
  overriddenSerials: i.movementEvents.filter((m) => m.overridden).map((m) => m.cylinder.serialCode),
  photo: i.photo ? toPhotoDto(i.photo) : null,
  photoOverridden: i.photoOverridden,
});

export async function initializationRoutes(app: FastifyInstance): Promise<void> {
  const findByRequestId = (clientRequestId: string) =>
    prisma.batchInitialization.findUnique({
      where: { clientRequestId },
      include: initializationInclude,
    });

  const replayBody = (i: InitializationRow): CreateInitializationResponse => ({
    initialization: toInitializationDto(i),
    // A replay reports no rejections: the original call already showed them.
    rejected: [],
  });

  app.post(
    '/initializations',
    { preHandler: app.requireRole('TECHNICIAN', 'STORES_MANAGER', 'ADMIN') },
    async (request, reply) => {
      const input = createInitializationRequestSchema.parse(request.body);

      const existing = await findByRequestId(input.clientRequestId);
      if (existing) return reply.code(200).send(replayBody(existing));

      // The scan requirement is CRITICAL ENFORCEMENT, so its one exception is gated
      // before anything else is evaluated — identical to transfers and returns.
      if (input.overrideSerials.length > 0 && request.user.role !== 'ADMIN') {
        return reply.code(403).send({
          error: {
            code: 'OVERRIDE_FORBIDDEN',
            message: 'Only an admin can initialize a cylinder without scanning it.',
          },
        });
      }

      const batch = await prisma.batch.findUnique({
        where: { id: input.batchId },
        select: { id: true, initializedAt: true },
      });
      if (!batch) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
      }
      // Not an error worth a rollback further in: a second initialization is a user
      // who tapped an old screen, and the honest answer is that it is already done.
      if (batch.initializedAt) {
        return reply.code(409).send({
          error: {
            code: 'ALREADY_INITIALIZED',
            message: 'This batch has already been initialized.',
            details: { initializedAt: batch.initializedAt.toISOString() },
          },
        });
      }

      const userId = request.user.sub;
      const prepared = await preparePhoto({
        photo: input.photo,
        photoOverride: input.photoOverride,
        role: request.user.role,
        userId,
        batchId: input.batchId,
        clientRequestId: input.clientRequestId,
        verb: 'initialization',
      });
      if (!prepared.ok) {
        return reply
          .code(prepared.status)
          .send({ error: { code: prepared.code, message: prepared.message } });
      }

      let result: { initializationId: string; rejected: ScanRejection[] };
      try {
        result = await prisma.$transaction(
          async (tx) => {
            // Claim the idempotency key FIRST, before evaluating a single scan — the
            // same ordering transfers use, and for the same reason: a concurrent
            // duplicate must block on the unique index and route to the replay path,
            // rather than reading state its own original already committed and
            // rejecting itself with a hard 4xx an outbox retry can never clear.
            const initialization = await tx.batchInitialization.create({
              data: {
                batchId: input.batchId,
                userId,
                clientRequestId: input.clientRequestId,
                photoOverridden: prepared.overridden,
              },
            });

            const { accepted, rejected } = await resolveScans(
              tx,
              input.batchId,
              input.scans,
              input.overrideSerials,
              // Initialization is the step that LIFTS this gate, so it is the one
              // caller that must not be subject to it.
              { requireInitialized: false },
            );

            // Every cylinder, or none. Read inside the transaction so a batch cannot
            // grow a cylinder between the check and the stamp.
            const all = await tx.cylinder.findMany({
              where: { batchId: input.batchId },
              select: { id: true, serialCode: true, currentSiteId: true },
              orderBy: { serialCode: 'asc' },
            });
            const acceptedIds = new Set(accepted.map((c) => c.id));
            const missing = all.filter((c) => !acceptedIds.has(c.id)).map((c) => c.serialCode);
            if (missing.length > 0) throw new IncompleteInitializationError(missing);

            const siteById = new Map(all.map((c) => [c.id, c.currentSiteId]));
            await tx.movementEvent.createMany({
              data: accepted.map((c) => ({
                cylinderId: c.id,
                type: 'INITIALIZE' as const,
                // Nothing moves: from and to are both where the cylinder already is.
                // The event records that it was SEEN, which is the fact being claimed.
                fromSiteId: siteById.get(c.id) ?? null,
                toSiteId: siteById.get(c.id) ?? null,
                userId,
                initializationId: initialization.id,
                deviceAt: c.scannedAt,
                overridden: c.overridden,
              })),
            });

            if (prepared.columns) {
              await tx.batchPhoto.create({
                data: { ...prepared.columns, initializationId: initialization.id },
              });
            }

            // Conditional in the WHERE rather than in an `if`, so two initializations
            // racing cannot have the second overwrite the first one's timestamp — the
            // loser matching zero rows is exactly the right outcome. The value is the
            // record's own DB-assigned createdAt, so the stamp and the record proving
            // it can never disagree.
            await tx.batch.updateMany({
              where: { id: input.batchId, initializedAt: null },
              data: { initializedAt: initialization.createdAt },
            });

            return { initializationId: initialization.id, rejected };
          },
          { timeout: 30_000, maxWait: 15_000 },
        );
      } catch (err) {
        if (err instanceof IncompleteInitializationError) {
          return reply.code(422).send({
            error: {
              code: 'INCOMPLETE_INITIALIZATION',
              message:
                `Initialization must cover every cylinder in the batch. ` +
                `${err.missing.length} were not scanned.`,
              details: { missingSerials: err.missing },
            },
          });
        }
        // Two devices replaying the same queued initialization at once: both missed
        // the findUnique above, one lost the unique index. That is a replay, not a
        // conflict — return what the winner created.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const winner = await findByRequestId(input.clientRequestId);
          if (winner) return reply.code(200).send(replayBody(winner));
        }
        throw err;
      }

      const full = await prisma.batchInitialization.findUniqueOrThrow({
        where: { id: result.initializationId },
        include: initializationInclude,
      });
      const body: CreateInitializationResponse = {
        initialization: toInitializationDto(full),
        rejected: result.rejected,
      };
      return reply.code(201).send(body);
    },
  );
}
