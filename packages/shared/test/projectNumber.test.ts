import { describe, it, expect } from 'vitest';
import {
  formatBatchDate,
  groupsOf,
  isValidProjectNumber,
  maskProjectNumber,
  maskToGroups,
  PROJECT_NUMBER_DIGITS,
  PROJECT_NUMBER_PLACEHOLDER,
} from '../src/index';

describe('maskProjectNumber', () => {
  it('inserts the dashes as digits arrive — 5-3-1-2', () => {
    expect(maskProjectNumber('1')).toBe('1');
    expect(maskProjectNumber('12345')).toBe('12345');
    expect(maskProjectNumber('123456')).toBe('12345-6');
    expect(maskProjectNumber('12345678')).toBe('12345-678');
    expect(maskProjectNumber('123456789')).toBe('12345-678-9');
    expect(maskProjectNumber('12345678901')).toBe('12345-678-9-01');
  });

  it('drops non-digits rather than letting them into the value', () => {
    expect(maskProjectNumber('12a34b5')).toBe('12345');
    expect(maskProjectNumber('PRJ-0001')).toBe('0001');
  });

  it('is idempotent, so a paste of a formatted number survives unchanged', () => {
    const formatted = '12345-678-9-01';
    expect(maskProjectNumber(formatted)).toBe(formatted);
    expect(maskProjectNumber(maskProjectNumber(formatted))).toBe(formatted);
  });

  it('cannot grow past a complete number', () => {
    expect(maskProjectNumber('1234567890123456')).toBe('12345-678-9-01');
    expect(PROJECT_NUMBER_DIGITS).toBe(11);
  });

  it('leaves a partially deleted value in a re-maskable state', () => {
    // Backspacing through a dash must not strand the field: the mask re-derives the
    // whole string from its digits, so the dash simply disappears with the group.
    expect(maskProjectNumber('12345-678-9-0')).toBe('12345-678-9-0');
    expect(maskProjectNumber('12345-678-9-')).toBe('12345-678-9');
    expect(maskProjectNumber('12345-678-')).toBe('12345-678');
  });
});

describe('isValidProjectNumber', () => {
  it('accepts exactly the documented shape', () => {
    expect(isValidProjectNumber('12345-678-9-01')).toBe(true);
    expect(isValidProjectNumber(PROJECT_NUMBER_PLACEHOLDER)).toBe(true);
  });

  it('rejects the old 6-digit shape, free text and every near miss', () => {
    for (const bad of [
      '123456-789-1-23', // the old 6-3-1-2 — no longer accepted as input
      'PRJ-0001',
      '1234-678-9-01', // 4 in the first group
      '12345-67-9-01',
      '12345-678-90-1', // groups shifted
      '12345-678-9-012',
      '12345678901', // unformatted
      '12345 678 9 01',
      '1234A-678-9-01',
      '',
    ]) {
      expect(isValidProjectNumber(bad), bad).toBe(false);
    }
  });

  it('agrees with the mask: a complete masked value always validates', () => {
    expect(isValidProjectNumber(maskProjectNumber('98765432109'))).toBe(true);
  });
});

describe('formatBatchDate', () => {
  it('renders the documented shape', () => {
    // Pinned to UTC by the test runner (vitest.config sets TZ), so this asserts the
    // format, not the machine's zone.
    expect(formatBatchDate('2026-08-31T14:32:00Z')).toBe('31 Aug 2026, 14:32');
  });

  it('is 24-hour, so 14:32 never renders as 2:32 PM', () => {
    expect(formatBatchDate('2026-01-05T09:07:00Z')).toBe('05 Jan 2026, 09:07');
    expect(formatBatchDate('2026-12-25T23:59:00Z')).toBe('25 Dec 2026, 23:59');
  });

  it('accepts a Date as readily as an ISO string', () => {
    expect(formatBatchDate(new Date('2026-08-31T14:32:00Z'))).toBe('31 Aug 2026, 14:32');
  });

  it('degrades to a dash rather than "Invalid Date" on missing or junk input', () => {
    // These reach the helper from nullable API fields; rendering NaN into a list row
    // is worse than admitting there is no date.
    expect(formatBatchDate(null)).toBe('—');
    expect(formatBatchDate(undefined)).toBe('—');
    expect(formatBatchDate('')).toBe('—');
    expect(formatBatchDate('not a date')).toBe('—');
  });
});

describe('typing an existing number — maskToGroups / groupsOf', () => {
  it('fits a current number, dashes added as you type', () => {
    const groups = groupsOf('52508-008-1-01')!;
    expect(groups).toEqual([5, 3, 1, 2]);
    expect(maskToGroups('5250800810', groups)).toBe('52508-008-1-0');
    expect(maskToGroups('52508008101', groups)).toBe('52508-008-1-01');
  });

  it('fits a number recorded in the old 6-3-1-2 shape too', () => {
    const groups = groupsOf('525080-008-1-01')!;
    expect(groups).toEqual([6, 3, 1, 2]);
    expect(maskToGroups('525080008101', groups)).toBe('525080-008-1-01');
  });

  it('has no grouping for a free-text number', () => {
    expect(groupsOf('PRJ-0001')).toBeNull();
  });
});
