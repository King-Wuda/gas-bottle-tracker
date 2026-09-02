/**
 * Display formatting for the batch timestamp — `31 Aug 2026, 14:32`.
 *
 * The one place the format lives (section 6 of the change spec): the confirmation
 * screen, the Transfer / Returns / History rows and the batch detail view all call
 * this, so moving or adding a display location is a one-line change.
 *
 * Rendered in the *viewer's* local time zone (no `timeZone` option => the runtime's
 * own zone), which is the point: the server stores `timestamptz` in UTC and the field
 * user reads it in the time they were standing in. The locale is pinned to en-GB
 * rather than the device locale so the shape is stable — a phone set to en-US would
 * otherwise render `Aug 31, 2026, 2:32 PM` and no longer match the spec.
 */
export function formatBatchDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
