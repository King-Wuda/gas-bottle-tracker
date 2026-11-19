/**
 * Start-time clean-up: delete every project whose number is not 5-3-1-2, then make the
 * database enforce the format for every row. See `src/services/legacyProjects.ts`.
 *
 * Run by `scripts/render-start.sh` after the migrations, on every start; once the old
 * projects are gone it does nothing.
 *
 *   npm run -w @gct/api cleanup:legacy-projects
 */
import { prisma } from '../src/db.js';
import { removeLegacyProjects } from '../src/services/legacyProjects.js';

removeLegacyProjects((line) => console.log(`legacy-projects: ${line}`))
  .then((r) => {
    console.log(
      `legacy-projects: done — ${r.deleted.length} deleted, ` +
        `format ${r.constraintValidated ? 'enforced' : 'NOT yet enforced'}`,
    );
  })
  .catch((err: unknown) => {
    console.error('legacy-projects: failed', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
