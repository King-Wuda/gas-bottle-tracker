/**
 * Serial-code formatting/parsing + an injectable clock + timezone-aware year.
 * Imported by BOTH apps and by the apps/api serial-allocation service.
 *
 * Serial format: [PREFIX][YY]-[SEQ]  e.g. NIT26-001, NIT26-1000
 *  - PREFIX: 2..6 chars of [A-Z0-9], per GasType.prefix
 *  - YY:     last two digits of the calendar year in SERIAL_YEAR_TZ
 *  - SEQ:    zero-padded to 3 digits, widening naturally past 999, never wrapping
 */

export const SERIAL_CODE_RE = /^[A-Z0-9]{2,6}\d{2}-\d{3,}$/;
export const PREFIX_RE = /^[A-Z0-9]{2,6}$/;

export function formatSerial(prefix: string, year: number, seq: number): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(`formatSerial: invalid prefix ${JSON.stringify(prefix)}`);
  }
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`formatSerial: seq must be a positive integer, got ${seq}`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2999) {
    throw new Error(`formatSerial: year out of range ${year}`);
  }
  const yy = String(year % 100).padStart(2, '0');
  const seqStr = seq < 1000 ? String(seq).padStart(3, '0') : String(seq); // widen past 999, never wrap
  return `${prefix}${yy}-${seqStr}`;
}

export interface ParsedSerial {
  prefix: string;
  yy: number;
  seq: number;
}

export function parseSerial(code: string): ParsedSerial {
  const m = /^([A-Z0-9]{2,6})(\d{2})-(\d{3,})$/.exec(code);
  if (!m) throw new Error(`parseSerial: not a serial code: ${JSON.stringify(code)}`);
  return { prefix: m[1]!, yy: Number(m[2]), seq: Number(m[3]) };
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string | number) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date | string | number): void {
    this.t = new Date(d).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Calendar year in the configured IANA time zone. Intl only — Node 24 ships full ICU. */
export function serialYear(clock: Clock, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).formatToParts(
    clock.now(),
  );
  const y = parts.find((p) => p.type === 'year')?.value;
  if (!y) throw new Error(`serialYear: could not resolve year for tz ${timeZone}`);
  return Number(y);
}

export function assertValidTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Invalid IANA time zone: ${tz}`);
  }
}
