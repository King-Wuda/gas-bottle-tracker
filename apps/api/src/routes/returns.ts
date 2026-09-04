import type { FastifyInstance } from 'fastify';
import {
  createReturnRequestSchema,
  describeSouthAfricanId,
  readDriverIdRequestSchema,
  type BatchStatus,
  type CreateReturnResponse,
  type ReadDriverIdResponse,
  type ReturnRecordDto,
  type ScanRejection,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';
import { prepareDriverSignOff } from '../services/driverSignOff.js';
import { readIdNumber } from '../services/idOcr.js';
import { preparePhoto } from '../services/photo.js';
import { toPhotoDto, type PhotoRow } from '../services/photoView.js';
import { resolveScans, scanRejection } from '../services/scans.js';

/** Rolls the transaction back when nothing survived validation, so a submission that
 *  returned no cylinder leaves neither a ReturnRecord nor a queued email. */
class NoValidScansError extends Error {
  constructor(public rejected: ScanRejection[]) {
    super('No scanned cylinder could be returned');
  }
}

type ReturnRow = {
  id: string;
  batchId: string;
  driverName: string;
  driverIdNumber: string | null;
  driverIdPath: string | null;
  driverIdOverridden: boolean;
  storesManagerId: string;
  photoOverridden: boolean;
  createdAt: Date;
  batch: { status: BatchStatus };
  movementEvents: { overridden: boolean; cylinder: { serialCode: string } }[];
  photo: PhotoRow | null;
};

export const returnInclude = {
  batch: { select: { status: true } },
  movementEvents: {
    select: { overridden: true, cylinder: { select: { serialCode: true } } },
    orderBy: { cylinder: { serialCode: 'asc' } },
  },
  photo: { include: { user: { select: { name: true } } } },
} as const;

/** One row of the atomic claim. `fromSiteId` is read through the row lock, so it is
 *  where the cylinder actually was — even if a transfer moved it a moment ago. */
interface ClaimedRow {
  id: string;
  serialCode: string;
  fromSiteId: string | null;
}

export async function returnRoutes(app: FastifyInstance): Promise<void> {
  const findByRequestId = (clientRequestId: string) =>
    prisma.returnRecord.findUnique({ where: { clientRequestId }, include: returnInclude });

  const outstandingFor = (batchId: string) =>
    prisma.cylinder.count({ where: { batchId, status: { not: 'RETURNED' } } });

  const toDto = (r: ReturnRow, outstandingCount: number): ReturnRecordDto => ({
    id: r.id,
    batchId: r.batchId,
    driverName: r.driverName,
    driverIdNumber: r.driverIdNumber,
    driverIdOverridden: r.driverIdOverridden,
    // Derived from the file actually on record rather than from the absence of an
    // override, so a return that predates ID capture reads as "no document" instead
    // of as "an admin waived it".
    driverIdCaptured: r.driverIdPath !== null,
    storesManagerId: r.storesManagerId,
    createdAt: r.createdAt.toISOString(),
    returnedSerials: r.movementEvents.map((m) => m.cylinder.serialCode),
    overriddenSerials: r.movementEvents
      .filter((m) => m.overridden)
      .map((m) => m.cylinder.serialCode),
    batchStatus: r.batch.status,
    outstandingCount,
    photo: r.photo ? toPhotoDto(r.photo) : null,
    photoOverridden: r.photoOverridden,
  });

  /**
   * Read the driver's ID number off a photograph of their document (Workflow C4).
   *
   * A convenience endpoint, and it behaves like one. It stores nothing, changes
   * nothing, and answers 200 whether or not it found a number — "we could not read
   * it" is a result, not a failure, and the operator's next move (type the number) is
   * the same either way. See `services/idOcr.ts` for why it will not guess.
   */
  app.post(
    '/driver-id/read',
    { preHandler: app.requireRole('STORES_MANAGER', 'ADMIN') },
    async (request, reply) => {
      const input = readDriverIdRequestSchema.parse(request.body);
      const result = await readIdNumber(input.imageBase64);
      const body: ReadDriverIdResponse = result.ok
        ? {
            idNumber: result.id.value,
            description: describeSouthAfricanId(result.id),
            reason: null,
          }
        : { idNumber: null, description: null, reason: result.reason };
      return reply.code(200).send(body);
    },
  );

  // Workflow C (server side): verify the scans, mark only what was physically
  // scanned as returned, roll the batch status forward, and queue the PM's note.
  app.post(
    '/returns',
    { preHandler: app.requireRole('STORES_MANAGER', 'ADMIN') },
    async (request, reply) => {
      const input = createReturnRequestSchema.parse(request.body);

      const existing = await findByRequestId(input.clientRequestId);
      if (existing) {
        return reply.code(200).send({
          returnRecord: toDto(existing, await outstandingFor(existing.batchId)),
          rejected: [],
        } satisfies CreateReturnResponse);
      }

      // Same gate as transfers: the one exception to mandatory scanning is admin-only,
      // and is refused rather than silently dropped for anyone else.
      if (input.overrideSerials.length > 0 && request.user.role !== 'ADMIN') {
        return reply.code(403).send({
          error: {
            code: 'OVERRIDE_FORBIDDEN',
            message: 'Only an admin can return a cylinder without scanning it.',
          },
        });
      }

      const batch = await prisma.batch.findUnique({
        where: { id: input.batchId },
        include: {
          project: true,
          projectManager: true,
          site: true,
          lines: { include: { gasType: { select: { name: true } } } },
        },
      });
      if (!batch) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
      }

      // A batch whose labels were never scanned back off its cylinders cannot be
      // scanned back IN either — see routes/transfers.ts for the full reasoning.
      if (!batch.initializedAt) {
        return reply.code(409).send({
          error: {
            code: 'BATCH_NOT_INITIALIZED',
            message:
              'This batch has not been initialized. Scan it in first (New → Initialize a batch) ' +
              'so its labels are on record before anything is returned.',
          },
        });
      }

      // Who took them, and the proof: the signature and the photographed ID, both
      // written before the transaction. See services/driverSignOff.ts.
      const signOff = await prepareDriverSignOff({
        clientRequestId: input.clientRequestId,
        signaturePng: input.signaturePng,
        driverIdPhoto: input.driverIdPhoto,
        driverIdOverride: input.driverIdOverride,
        role: request.user.role,
        verb: 'return',
      });
      if (!signOff.ok) {
        return reply
          .code(signOff.status)
          .send({ error: { code: signOff.code, message: signOff.message } });
      }

      const userId = request.user.sub;

      // Same reasoning as the signature above: filesystem IO, so it happens before
      // any row is locked.
      const prepared = await preparePhoto({
        photo: input.photo,
        photoOverride: input.photoOverride,
        role: request.user.role,
        userId,
        batchId: input.batchId,
        clientRequestId: input.clientRequestId,
        verb: 'return',
      });
      if (!prepared.ok) {
        return reply
          .code(prepared.status)
          .send({ error: { code: prepared.code, message: prepared.message } });
      }

      let result: { returnRecordId: string; rejected: ScanRejection[] };
      try {
        result = await prisma.$transaction(
          async (tx) => {
            // Serialise returns on this batch, BEFORE inserting anything.
            //
            // Why the lock at all: the batch's ACTIVE/PARTIAL/RETURNED status is a
            // function of ALL its cylinders, so two concurrent returns each counting
            // within their own snapshot would both conclude "PARTIAL" — and a batch
            // whose every cylinder came back would accrue rental forever.
            //
            // Why FIRST: `ReturnRecord.batchId` is a foreign key, so inserting the
            // record takes a FOR KEY SHARE lock on this same Batch row. Locking
            // after the insert means both transactions hold KEY SHARE and both then
            // ask to upgrade — a textbook deadlock, and it fired on the first
            // concurrent test run (40P01). Taking the stronger lock first gives one
            // consistent order: batch -> record -> cylinders.
            //
            // Why NO KEY UPDATE: we never change the Batch's key, and this strength
            // still conflicts with itself (so returns stay serialised) while staying
            // compatible with the KEY SHARE that a concurrent TRANSFER needs to
            // insert its own row against this batch.
            await tx.$queryRaw`SELECT "id" FROM "Batch" WHERE "id" = ${input.batchId} FOR NO KEY UPDATE`;

            // Then the idempotency key. A concurrent duplicate that got this far
            // waited on the batch lock, so its insert now hits the unique index and
            // routes to the replay path — rather than reading state its own original
            // already committed and rejecting itself as ALREADY_RETURNED. (The
            // transfer route had exactly that defect; see docs/BUILD_BLUEPRINT.md.)
            const record = await tx.returnRecord.create({
              data: {
                batchId: input.batchId,
                storesManagerId: userId,
                driverName: input.driverName,
                driverIdNumber: input.driverIdNumber,
                driverIdPath: signOff.driverIdPath,
                driverIdOverridden: signOff.driverIdOverridden,
                signaturePath: signOff.signaturePath,
                photoOverridden: prepared.overridden,
                clientRequestId: input.clientRequestId,
              },
            });

            if (prepared.columns) {
              await tx.batchPhoto.create({
                data: { ...prepared.columns, returnRecordId: record.id },
              });
            }

            const { accepted, rejected } = await resolveScans(
              tx,
              input.batchId,
              input.scans,
              input.overrideSerials,
            );
            if (accepted.length === 0) throw new NoValidScansError(rejected);

            // THE CLAIM — the single statement that decides what is returned.
            const ids = accepted.map((c) => c.id);
            const claimed = await tx.$queryRaw<ClaimedRow[]>`
              WITH locked AS (
                SELECT "id", "serialCode", "currentSiteId"
                FROM "Cylinder"
                WHERE "id" IN (${Prisma.join(ids)})
                  AND "batchId" = ${input.batchId}
                  AND "status" <> 'RETURNED'
                ORDER BY "id"
                FOR UPDATE
              )
              UPDATE "Cylinder" AS c
              SET "status" = 'RETURNED', "currentSiteId" = NULL, "updatedAt" = now()
              FROM locked AS l
              WHERE c."id" = l."id"
              RETURNING c."id", c."serialCode", l."currentSiteId" AS "fromSiteId"
            `;

            const claimedIds = new Set(claimed.map((c) => c.id));
            for (const c of accepted) {
              if (!claimedIds.has(c.id)) {
                rejected.push(
                  scanRejection(
                    c.serialCode,
                    'CONFLICT',
                    'Another user returned this cylinder first.',
                  ),
                );
              }
            }
            if (claimed.length === 0) throw new NoValidScansError(rejected);

            const bySerial = new Map(accepted.map((c) => [c.serialCode, c]));
            await tx.movementEvent.createMany({
              data: claimed.map((c) => ({
                cylinderId: c.id,
                type: 'RETURN' as const,
                fromSiteId: c.fromSiteId,
                toSiteId: null, // returned cylinders leave every site
                userId,
                returnRecordId: record.id,
                deviceAt: bySerial.get(c.serialCode)?.scannedAt ?? new Date(),
                overridden: bySerial.get(c.serialCode)?.overridden ?? false,
              })),
            });

            // Roll the batch status forward. Safe under the batch lock taken above:
            // this count now sees every committed return, including one that landed
            // while we were waiting.
            const outstanding = await tx.cylinder.count({
              where: { batchId: input.batchId, status: { not: 'RETURNED' } },
            });
            await tx.batch.update({
              where: { id: input.batchId },
              data: {
                status: outstanding === 0 ? 'RETURNED' : 'PARTIAL',
                // Only the return that empties the batch stamps it. A PARTIAL batch
                // has not "been returned" and must stay in the Returns list. Taken
                // from the ReturnRecord's own DB timestamp so the stamp and the
                // signed note it came from agree to the millisecond.
                ...(outstanding === 0 ? { returnedAt: record.createdAt } : {}),
              },
            });

            await tx.outboundEmail.create({
              data: {
                // The batch's own manager, which a transfer or an admin correction may
                // have changed since it was booked in — not the project's default.
                to: batch.projectManagerEmail,
                type: 'DELIVERY_NOTE',
                subject: `Delivery note — ${claimed.length} cylinder(s) returned, project ${batch.project.projectNumber}`,
                bodyText:
                  `${claimed.length} cylinder(s) were collected from "${batch.site.name}" ` +
                  `and signed for by ${input.driverName}.\n` +
                  (outstanding === 0
                    ? 'This completes the batch — all cylinders are now returned.\n'
                    : `${outstanding} cylinder(s) from this batch are still outstanding.\n`) +
                  'The signed delivery note is attached.',
                payload: { returnRecordId: record.id },
              },
            });

            return { returnRecordId: record.id, rejected };
          },
          { timeout: 20_000, maxWait: 10_000 },
        );
      } catch (err) {
        if (err instanceof NoValidScansError) {
          return reply.code(422).send({
            error: {
              code: 'NO_VALID_SCANS',
              message: 'No scanned cylinder could be returned.',
              details: { rejected: err.rejected },
            },
          });
        }
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const winner = await findByRequestId(input.clientRequestId);
          if (winner) {
            return reply.code(200).send({
              returnRecord: toDto(winner, await outstandingFor(winner.batchId)),
              rejected: [],
            } satisfies CreateReturnResponse);
          }
        }
        throw err;
      }

      const full = await prisma.returnRecord.findUniqueOrThrow({
        where: { id: result.returnRecordId },
        include: returnInclude,
      });
      const body: CreateReturnResponse = {
        returnRecord: toDto(full, await outstandingFor(full.batchId)),
        rejected: result.rejected,
      };
      return reply.code(201).send(body);
    },
  );
}
