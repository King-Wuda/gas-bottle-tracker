import { prisma } from '../db.js';
import { deleteProject, type DeletionImpact } from './adminDelete.js';

/**
 * Removes every project whose number is not in the current 5-3-1-2 format — the
 * six-digit numbers from before the format was corrected, and any free-text ones from
 * before there was a format — then has the database VALIDATE its format constraint, so
 * from that point no project number in another shape can exist at all.
 *
 * Every such project was test data (confirmed before this was written), and each goes
 * through `deleteProject` — the same path, delete order and blob clean-up as the Delete
 * button on Admin → Projects — rather than raw SQL that would have to repeat it.
 *
 * Idempotent: run on every start (see `scripts/render-start.sh`), it finds nothing to do
 * once the old projects are gone, and validating an already-valid constraint is a no-op.
 */
export const PROJECT_NUMBER_SQL_PATTERN = '^[0-9]{5}-[0-9]{3}-[0-9]{1}-[0-9]{2}$';

export interface LegacyCleanupResult {
  deleted: { projectNumber: string; impact: DeletionImpact }[];
  /** True once the database guarantees the format for every row. */
  constraintValidated: boolean;
}

export async function removeLegacyProjects(
  say: (line: string) => void = () => {},
): Promise<LegacyCleanupResult> {
  const legacy = await prisma.$queryRaw<{ id: string; projectNumber: string }[]>`
    SELECT "id", "projectNumber" FROM "Project"
    WHERE "projectNumber" !~ ${PROJECT_NUMBER_SQL_PATTERN}
    ORDER BY "projectNumber"
  `;

  const deleted: LegacyCleanupResult['deleted'] = [];
  for (const p of legacy) {
    const impact = await deleteProject(p.id);
    deleted.push({ projectNumber: p.projectNumber, impact });
    say(
      `deleted old-format project ${p.projectNumber}: ${impact.batches} batch(es), ` +
        `${impact.cylinders} cylinder(s), ${impact.movementEvents} movement(s), ` +
        `${impact.files} stored file(s)`,
    );
  }

  // Only once nothing is left in the old shape — VALIDATE would fail on a survivor.
  // A constraint that has been dropped or redefined by hand is left alone.
  const [constraint] = await prisma.$queryRaw<{ convalidated: boolean }[]>`
    SELECT "convalidated" FROM pg_constraint WHERE "conname" = 'Project_projectNumber_format'
  `;
  let constraintValidated = constraint?.convalidated ?? false;
  if (constraint && !constraint.convalidated) {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "Project" VALIDATE CONSTRAINT "Project_projectNumber_format"',
    );
    constraintValidated = true;
    say('project number format is now enforced for every project');
  }

  if (deleted.length === 0) say('no old-format projects found');
  return { deleted, constraintValidated };
}
