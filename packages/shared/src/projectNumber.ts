/**
 * Project number format — `######-###-#-##`, e.g. `123456-789-1-23`.
 *
 * One definition, three enforcement points: this regex backs the zod schema the API
 * parses with, the mask the device types through, and the `Project_projectNumber_format`
 * CHECK constraint in the database. The constraint is the backstop — client validation
 * alone cannot stop a bad row, because the API is reachable without the app.
 */

export const PROJECT_NUMBER_REGEX = /^\d{6}-\d{3}-\d{1}-\d{2}$/;

/** Shown as the input placeholder AND quoted in the error, so they cannot drift. */
export const PROJECT_NUMBER_PLACEHOLDER = '123456-789-1-23';

export const PROJECT_NUMBER_ERROR = `Format must be ${PROJECT_NUMBER_PLACEHOLDER}`;

/** Digit counts per dash-separated group. Sums to PROJECT_NUMBER_DIGITS. */
const GROUPS = [6, 3, 1, 2] as const;

export const PROJECT_NUMBER_DIGITS = GROUPS.reduce((n, g) => n + g, 0); // 12

/**
 * Formats whatever the user typed into the canonical shape.
 *
 * Non-digits are dropped rather than rejected in place: the field is fed by an
 * on-screen number pad and by paste, and a pasted `123456-789-1-23` must survive
 * round-tripping through the mask unchanged. Digits past the twelfth are discarded,
 * so the field cannot grow beyond a valid number.
 */
export function maskProjectNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, PROJECT_NUMBER_DIGITS);
  const parts: string[] = [];
  let at = 0;
  for (const size of GROUPS) {
    if (at >= digits.length) break;
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  return parts.join('-');
}

export const isValidProjectNumber = (value: string): boolean => PROJECT_NUMBER_REGEX.test(value);
