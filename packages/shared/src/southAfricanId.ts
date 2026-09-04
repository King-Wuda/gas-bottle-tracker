/**
 * Reading a South African ID number.
 *
 * ## What this is for
 *
 * The app never REQUIRES an ID number to be South African — a collection driver may
 * be carrying a passport, a foreign licence or an asylum permit, and one who cannot
 * be recorded is one who leaves with the cylinders and no name against them. See
 * `driverIdNumberSchema` in `schemas/return.ts`, which deliberately accepts anything.
 *
 * This module exists for the opposite job: deciding whether a number the app READ for
 * itself — off a photographed document, or out of a barcode — is trustworthy enough
 * to put in front of an operator as a suggestion. An OCR misread of a 13-digit number
 * is very likely to be another 13-digit number, so "it has thirteen digits" is not a
 * check at all. The checksum is, and it is the whole reason autofill is safe here:
 * a misread fails, rather than filling in someone else's identity.
 */

/** The digits, in the order the format defines them: YYMMDD SSSS C A Z. */
const ID_PATTERN = /^\d{13}$/;

/**
 * The Luhn check the last digit carries.
 *
 * Doubling every second digit from the right and summing the digits of the results —
 * the same algorithm a bank card uses. It catches EVERY single-digit error, and every
 * adjacent transposition except `09` <-> `90`, which it is blind to because doubling
 * 0 gives 0 and doubling 9 digit-sums back to 9. That blind spot is why the OCR path
 * also refuses to suggest anything when it finds more than one candidate: the
 * checksum is strong, not perfect, and the operator is still shown the number to
 * check against the card in their hand.
 */
export function hasValidIdChecksum(value: string): boolean {
  if (!ID_PATTERN.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const digit = Number(value[12 - i]);
    if (i % 2 === 1) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return sum % 10 === 0;
}

export interface SouthAfricanId {
  /** The 13 digits, with any spaces the document printed them with removed. */
  value: string;
  /**
   * Best effort — see `resolveCentury`. Null when the six date digits are not a real
   * date, which a valid checksum does not rule out.
   */
  dateOfBirth: string | null;
  gender: 'male' | 'female';
  citizenship: 'citizen' | 'permanent-resident';
}

/**
 * The century the two-digit year belongs to.
 *
 * The format simply does not record it, so this is a guess and is documented as one:
 * a year that has not happened yet must be the last century, and anything else is
 * taken as this one. It is wrong for somebody over about a hundred years old, which
 * is a trade worth making — the alternative is refusing to show a date of birth at
 * all, and the date is here so that an operator can glance at the card and see that
 * the app read the right one.
 */
function resolveCentury(twoDigitYear: number, today: Date): number {
  const thisCentury = Math.floor(today.getUTCFullYear() / 100) * 100;
  const candidate = thisCentury + twoDigitYear;
  return candidate > today.getUTCFullYear() ? candidate - 100 : candidate;
}

/** `null` for anything that is not a well-formed, checksum-valid ID number. */
export function parseSouthAfricanId(input: string, today = new Date()): SouthAfricanId | null {
  const value = input.replace(/\s/g, '');
  if (!hasValidIdChecksum(value)) return null;

  const year = resolveCentury(Number(value.slice(0, 2)), today);
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  // `Date` rolls 31 February forward into March rather than rejecting it, so the
  // round-trip below is what actually decides whether the date is real.
  const asDate = new Date(Date.UTC(year, month - 1, day));
  const realDate =
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day;

  return {
    value,
    dateOfBirth: realDate ? asDate.toISOString().slice(0, 10) : null,
    // The four sequence digits split the register in half at 5000.
    gender: Number(value.slice(6, 10)) >= 5000 ? 'male' : 'female',
    citizenship: value[10] === '0' ? 'citizen' : 'permanent-resident',
  };
}

/**
 * Every checksum-valid ID number in a piece of text, most-trustworthy first.
 *
 * Three passes, in descending order of how sure they are, because the ways this text
 * arrives are genuinely different:
 *
 * 1. **A line that is nothing but the number.** Documents print it grouped —
 *    `800101 5009 087` — so the separators are stripped per line and an exact
 *    thirteen digits is as good as it gets.
 * 2. **A run of digits with the number in it.** OCR routinely welds the number to the
 *    label beside it, so every window inside one whitespace-delimited run is tried.
 * 3. **A line with the number split across other numbers.** Same idea over the whole
 *    line's digits. This is the loosest pass and the one that can turn up a
 *    coincidence, which is why the caller is expected to act only on an unambiguous
 *    result — see the note on `hasValidIdChecksum`.
 *
 * Deliberately NOT a single pass over every digit on the page: sliding a window over
 * sixty concatenated digits gives dozens of chances for one to satisfy the checksum
 * by luck, and a confident wrong answer is far worse here than no answer.
 */
export function findSouthAfricanIds(text: string): string[] {
  const found: string[] = [];
  const take = (candidate: string): void => {
    if (hasValidIdChecksum(candidate) && !found.includes(candidate)) found.push(candidate);
  };
  const windows = (digits: string): void => {
    for (let i = 0; i + 13 <= digits.length; i++) take(digits.slice(i, i + 13));
  };
  const lines = text.split(/[\r\n]+/);

  for (const line of lines) take(line.replace(/[^\d]/g, ''));
  for (const line of lines) {
    for (const run of line.split(/\s+/)) windows(run.replace(/[^\d]/g, ''));
  }
  for (const line of lines) windows(line.replace(/[^\d]/g, ''));

  return found;
}

/** "8001015009087 · born 1980-01-01 · male" — what an operator checks against the
 *  card in their hand before accepting a suggestion. */
export function describeSouthAfricanId(id: SouthAfricanId): string {
  const parts = [id.value];
  if (id.dateOfBirth) parts.push(`born ${id.dateOfBirth}`);
  parts.push(id.gender);
  if (id.citizenship === 'permanent-resident') parts.push('permanent resident');
  return parts.join(' · ');
}
