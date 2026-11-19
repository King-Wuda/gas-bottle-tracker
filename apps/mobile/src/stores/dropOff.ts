import type { CachedCylinder } from '../db';

/**
 * The rules behind the stores drop-off screens, kept free of React Native so they can
 * be tested directly: which gases a drop-off holds, when every one has a cage, and the
 * request field that names them.
 */

export interface GasInDropOff {
  gasTypeId: string;
  gasTypeName: string;
  count: number;
}

/** The gases among these serials, with how many of each, in name order. */
export function gasesIn(
  cylinders: readonly Pick<CachedCylinder, 'serialCode' | 'gasTypeId' | 'gasTypeName'>[],
  serials: readonly string[],
): GasInDropOff[] {
  const wanted = new Set(serials);
  const byGas = new Map<string, GasInDropOff>();
  for (const c of cylinders) {
    if (!wanted.has(c.serialCode)) continue;
    const g = byGas.get(c.gasTypeId) ?? {
      gasTypeId: c.gasTypeId,
      gasTypeName: c.gasTypeName,
      count: 0,
    };
    g.count += 1;
    byGas.set(c.gasTypeId, g);
  }
  return [...byGas.values()].sort((a, b) => a.gasTypeName.localeCompare(b.gasTypeName));
}

/** The request field: one `{ gasTypeId, cage }` per gas in the drop-off. */
export const cagesPayload = (gases: readonly GasInDropOff[], cages: Record<string, number>) =>
  gases.flatMap((g) =>
    cages[g.gasTypeId] !== undefined ? [{ gasTypeId: g.gasTypeId, cage: cages[g.gasTypeId]! }] : [],
  );
