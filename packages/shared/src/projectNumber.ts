/**
 * Project number format — `#####-###-#-##` (5-3-1-2), e.g. `12345-678-9-01`.
 *
 * One definition, three enforcement points: this regex backs the zod schema the API
 * parses with, the mask the device types through, and the `Project_projectNumber_format`
 * CHECK constraint in the database. The constraint is the backstop — client validation
 * alone cannot stop a bad row, because the API is reachable without the app.
 *
 * It was 6-3-1-2 until 2026-11; the first group is really five digits. The projects
 * recorded under the old shape were all test data and are deleted on start by
 * `apps/api/scripts/remove-legacy-projects.ts`, after which the database validates the
 * constraint (migration `20261119120000_project_number_5_3_1_2`) for every row.
 */

export const PROJECT_NUMBER_REGEX = /^\d{5}-\d{3}-\d{1}-\d{2}$/;

/** Shown as the input placeholder AND quoted in the error, so they cannot drift. */
export const PROJECT_NUMBER_PLACEHOLDER = '12345-678-9-01';

export const PROJECT_NUMBER_ERROR = `Format must be ${PROJECT_NUMBER_PLACEHOLDER}`;

/** Digit counts per dash-separated group. Sums to PROJECT_NUMBER_DIGITS. */
const GROUPS = [5, 3, 1, 2] as const;

export const PROJECT_NUMBER_DIGITS = GROUPS.reduce((n, g) => n + g, 0); // 11

/**
 * Formats whatever the user typed into the canonical shape.
 *
 * Non-digits are dropped rather than rejected in place: the field is fed by an
 * on-screen number pad and by paste, and a pasted `12345-678-9-01` must survive
 * round-tripping through the mask unchanged. Digits past the eleventh are discarded,
 * so the field cannot grow beyond a valid number.
 */
export function maskProjectNumber(raw: string): string {
  return maskToGroups(raw, GROUPS);
}

/**
 * The same mask for a given grouping — digits only, dashes inserted at the group
 * boundaries, nothing past the last group.
 */
export function maskToGroups(raw: string, groups: readonly number[]): string {
  const total = groups.reduce((n, g) => n + g, 0);
  const digits = raw.replace(/\D/g, '').slice(0, total);
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    if (at >= digits.length) break;
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  return parts.join('-');
}

/**
 * The grouping of an EXISTING project number — `[5, 3, 1, 2]` for a current one,
 * `[6, 3, 1, 2]` for one recorded before the format changed. Null when it is not
 * digit groups joined by dashes (the free-text numbers from before any format).
 *
 * For typing a number that already exists — confirming a delete — where the field has
 * to fit the number on record, whatever shape it was recorded in.
 */
export function groupsOf(projectNumber: string): number[] | null {
  if (!/^\d+(-\d+)*$/.test(projectNumber)) return null;
  return projectNumber.split('-').map((g) => g.length);
}

export const isValidProjectNumber = (value: string): boolean => PROJECT_NUMBER_REGEX.test(value);
