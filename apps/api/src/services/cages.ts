import type { CageAssignmentDto, GasCages } from '@gct/shared';
import type { Prisma } from '../db.js';

/**
 * Putting cylinders into stores cages — shared by initialization and transfers back to
 * stores, the two events that land cylinders in stores.
 *
 * One cage per gas per drop-off: every argon cylinder in this drop-off goes into the
 * cage chosen for argon. The database separately refuses a cage on a cylinder that is
 * not IN_STORES (`Cylinder_cage_only_in_stores`), so these helpers only ever run on
 * cylinders that are.
 */

export type CageCheck =
  | { ok: true; cageByGas: Map<string, number> }
  | { ok: false; status: 400; code: string; message: string; details: unknown };

/**
 * A cage is OPTIONAL: a gas with no cage chosen goes into stores with none, and a
 * stores manager can put it in one later from the batch (`PATCH /batches/:id/cages`).
 * What is refused is a cage named for a gas that is not going in — that means the
 * screen and the server disagree about what is moving, and saying so beats guessing
 * which one is right.
 *
 * `allowExtra` is for transfers, where the set that moves is only known after the
 * claim: a cage chosen for nitrogen is not an error just because both nitrogen
 * cylinders turned out to have been moved by someone else a moment earlier.
 */
export function checkCages(
  gasesIntoStores: ReadonlySet<string>,
  cages: GasCages,
  { allowExtra = false }: { allowExtra?: boolean } = {},
): CageCheck {
  const cageByGas = new Map(cages.map((c) => [c.gasTypeId, c.cage]));
  const extra = [...cageByGas.keys()].filter((g) => !gasesIntoStores.has(g));
  if (extra.length > 0 && !allowExtra) {
    return {
      ok: false,
      status: 400,
      code: 'CAGE_NOT_NEEDED',
      message: 'A cage was chosen for a gas that is not going into stores.',
      details: { gasTypeIds: extra },
    };
  }
  return { ok: true, cageByGas };
}

/** Thrown inside a transaction when the cylinders that actually moved need a cage the
 *  request did not give — which is only knowable after the claim. Rolls back. */
export class CageCheckError extends Error {
  constructor(public check: Extract<CageCheck, { ok: false }>) {
    super(check.message);
  }
}

/** Set the cage on each gas's cylinders. One UPDATE per gas — a drop-off has a handful. */
export async function applyCages(
  tx: Prisma.TransactionClient,
  cylinderIdsByGas: ReadonlyMap<string, readonly string[]>,
  cageByGas: ReadonlyMap<string, number>,
): Promise<void> {
  for (const [gasTypeId, ids] of cylinderIdsByGas) {
    const cage = cageByGas.get(gasTypeId);
    if (cage === undefined || ids.length === 0) continue;
    await tx.cylinder.updateMany({ where: { id: { in: [...ids] } }, data: { cage } });
  }
}

/** The movement-event fields a DTO needs to say which gas went into which cage. */
export const cageEventSelect = {
  cage: true,
  contents: true,
  cylinder: { select: { serialCode: true, gasType: { select: { id: true, name: true } } } },
} as const;

/** Distinct gas → cage, read back from an event's own movement rows. */
export function cageAssignments(
  events: readonly { cage: number | null; cylinder: { gasType: { id: string; name: string } } }[],
): CageAssignmentDto[] {
  const seen = new Map<string, CageAssignmentDto>();
  for (const e of events) {
    if (e.cage === null || seen.has(e.cylinder.gasType.id)) continue;
    seen.set(e.cylinder.gasType.id, {
      gasTypeId: e.cylinder.gasType.id,
      gasTypeName: e.cylinder.gasType.name,
      cage: e.cage,
    });
  }
  return [...seen.values()].sort((a, b) => a.gasTypeName.localeCompare(b.gasTypeName));
}
