import type { FastifyInstance } from 'fastify';
import {
  setBatchCagesRequestSchema,
  type BatchCagesResponse,
  type BatchDetailResponse,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';
import { emailDeliveryFor, loadBatchDto } from '../services/batchView.js';

/**
 * `PATCH /batches/:id/cages` — the stores manager's one edit to a batch: which cage
 * each gas is in.
 *
 * Choosing a cage is optional when cylinders come into stores (initialization, or a
 * transfer back), so this is where a gas is put into a cage afterwards, or moved to
 * another one. A project manager can do it too; nobody else can. It changes nothing
 * but `Cylinder.cage`, on the batch's cylinders of that gas that are physically in
 * stores, and records the change on the batch's correction trail with who made it.
 *
 * "Physically in stores" is narrower than `status = IN_STORES`: every cylinder is
 * booked IN_STORES at intake, but one on a line delivered straight to SITE is out on
 * site until it is first transferred back, and putting it in a cage would be fiction.
 */
const CAGE_LABEL = (cage: number | null): string => (cage === null ? 'No cage' : `Cage ${cage}`);

/** The batch's cylinders that are physically in stores — see the note above. */
const physicallyInStores = (batchId: string, gasTypeId?: string): Prisma.CylinderWhereInput => ({
  batchId,
  ...(gasTypeId ? { gasTypeId } : {}),
  status: 'IN_STORES',
  OR: [
    { batchLine: { initialDeliveryPoint: 'STORES' } },
    { movementEvents: { some: { type: 'TRANSFER' } } },
  ],
});

export async function batchCageRoutes(app: FastifyInstance): Promise<void> {
  const storesOnly = { preHandler: app.requireRole('STORES_MANAGER', 'PROJECT_MANAGER') };

  /** What the cage screen shows: each gas in stores, and how many are in each cage. */
  app.get('/batches/:id/cages', storesOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const batch = await prisma.batch.findUnique({
      where: { id },
      select: { id: true, project: { select: { projectNumber: true } } },
    });
    if (!batch) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
    }
    const rows = await prisma.cylinder.findMany({
      where: physicallyInStores(id),
      select: { cage: true, gasType: { select: { id: true, name: true } } },
    });
    const byGas = new Map<string, BatchCagesResponse['gases'][number]>();
    for (const r of rows) {
      const g = byGas.get(r.gasType.id) ?? {
        gasTypeId: r.gasType.id,
        gasTypeName: r.gasType.name,
        inStores: 0,
        byCage: [],
      };
      g.inStores += 1;
      const slot = g.byCage.find((c) => c.cage === r.cage);
      if (slot) slot.count += 1;
      else g.byCage.push({ cage: r.cage, count: 1 });
      byGas.set(r.gasType.id, g);
    }
    const gases = [...byGas.values()]
      .map((g) => ({ ...g, byCage: g.byCage.sort((a, b) => (a.cage ?? 0) - (b.cage ?? 0)) }))
      .sort((a, b) => a.gasTypeName.localeCompare(b.gasTypeName));
    const body: BatchCagesResponse = {
      batchId: id,
      projectNumber: batch.project.projectNumber,
      gases,
    };
    return body;
  });

  app.patch('/batches/:id/cages', storesOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = setBatchCagesRequestSchema.parse(request.body);

    const batch = await prisma.batch.findUnique({ where: { id }, select: { id: true } });
    if (!batch) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Batch not found' } });
    }

    const gasNames = new Map(
      (
        await prisma.gasType.findMany({
          where: { id: { in: input.cages.map((c) => c.gasTypeId) } },
          select: { id: true, name: true },
        })
      ).map((g) => [g.id, g.name]),
    );

    const inStores = (gasTypeId: string) => physicallyInStores(id, gasTypeId);

    const result = await prisma.$transaction(async (tx) => {
      const changes: { field: string; from: string; to: string }[] = [];
      const nothingThere: string[] = [];

      for (const { gasTypeId, cage } of input.cages) {
        const cylinders = await tx.cylinder.findMany({
          where: inStores(gasTypeId),
          select: { id: true, cage: true },
        });
        const name = gasNames.get(gasTypeId) ?? 'Unknown gas';
        if (cylinders.length === 0) {
          nothingThere.push(name);
          continue;
        }
        if (cylinders.every((c) => c.cage === cage)) continue;

        const before = [...new Set(cylinders.map((c) => c.cage))]
          .sort((a, b) => (a ?? 0) - (b ?? 0))
          .map(CAGE_LABEL)
          .join(', ');
        await tx.cylinder.updateMany({
          where: { id: { in: cylinders.map((c) => c.id) } },
          data: { cage },
        });
        changes.push({
          field: `Cage — ${name} (${cylinders.length} in stores)`,
          from: before,
          to: CAGE_LABEL(cage),
        });
      }

      if (nothingThere.length > 0) return { ok: false as const, nothingThere };
      if (changes.length > 0) {
        await tx.batchAmendment.create({
          data: {
            batchId: id,
            userId: request.user.sub,
            changes: changes as unknown as Prisma.InputJsonValue,
            reason: input.reason?.trim() || null,
          },
        });
      }
      return { ok: true as const };
    });

    if (!result.ok) {
      return reply.code(400).send({
        error: {
          code: 'NOT_IN_STORES',
          message:
            `This batch has no ${result.nothingThere.join(' or ')} in stores, so there is ` +
            `nothing to put in a cage.`,
        },
      });
    }

    const body: BatchDetailResponse = {
      batch: (await loadBatchDto(id))!,
      emailDelivery: await emailDeliveryFor(id),
    };
    return body;
  });
}
