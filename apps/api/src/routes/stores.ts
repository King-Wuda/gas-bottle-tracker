import type { FastifyInstance } from 'fastify';
import { CAGES, type StoresGasSummary, type StoresSummaryResponse } from '@gct/shared';
import { prisma } from '../db.js';

/**
 * The stores console: every cylinder still in rotation, by gas — how many there are in
 * total, how many are in stores and whether they are full or empty, which cage they
 * are in, and how many are out on site.
 *
 * One grouped query rather than per-gas counts: the answer is a small grid, and the
 * `(gasTypeId, status, cage, contents)` index exists for exactly this GROUP BY.
 * Returned cylinders are excluded outright — they have gone back to the supplier and
 * are no longer in the system.
 */
export async function storesRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/stores/summary',
    { preHandler: app.requireRole('STORES_MANAGER', 'PROJECT_MANAGER') },
    async () => {
      const [groups, gasTypes] = await Promise.all([
        prisma.cylinder.groupBy({
          by: ['gasTypeId', 'status', 'cage', 'contents'],
          where: { status: { not: 'RETURNED' } },
          _count: { _all: true },
        }),
        prisma.gasType.findMany({ select: { id: true, name: true, active: true } }),
      ]);

      const blank = (g: { id: string; name: string }): StoresGasSummary => ({
        gasTypeId: g.id,
        gasTypeName: g.name,
        total: 0,
        inStores: { full: 0, empty: 0 },
        onSite: 0,
        inTransit: 0,
        cages: CAGES.map((cage) => ({ cage, full: 0, empty: 0 })),
        noCage: { full: 0, empty: 0 },
      });

      // Every gas the batch form offers shows up even at zero — "we have no argon" is
      // an answer the console should give. A retired gas appears only while
      // cylinders of it are still in rotation.
      const byGas = new Map<string, StoresGasSummary>(
        gasTypes.filter((g) => g.active).map((g) => [g.id, blank(g)]),
      );
      const nameById = new Map(gasTypes.map((g) => [g.id, g]));

      for (const row of groups) {
        const gas = nameById.get(row.gasTypeId);
        if (!gas) continue;
        let s = byGas.get(row.gasTypeId);
        if (!s) {
          s = blank(gas);
          byGas.set(row.gasTypeId, s);
        }
        const n = row._count._all;
        s.total += n;
        if (row.status === 'DEPLOYED') s.onSite += n;
        else if (row.status === 'IN_TRANSIT') s.inTransit += n;
        else if (row.status === 'IN_STORES') {
          const key = row.contents === 'EMPTY' ? 'empty' : 'full';
          s.inStores[key] += n;
          const bucket = s.cages.find((c) => c.cage === row.cage) ?? s.noCage;
          bucket[key] += n;
        }
      }

      const gases = [...byGas.values()].sort((a, b) => a.gasTypeName.localeCompare(b.gasTypeName));
      const body: StoresSummaryResponse = {
        gases,
        totals: gases.reduce(
          (t, g) => ({
            total: t.total + g.total,
            inStores: {
              full: t.inStores.full + g.inStores.full,
              empty: t.inStores.empty + g.inStores.empty,
            },
            onSite: t.onSite + g.onSite,
            inTransit: t.inTransit + g.inTransit,
          }),
          { total: 0, inStores: { full: 0, empty: 0 }, onSite: 0, inTransit: 0 },
        ),
      };
      return body;
    },
  );
}
