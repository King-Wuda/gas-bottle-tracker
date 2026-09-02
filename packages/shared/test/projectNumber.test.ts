import { describe, it, expect } from 'vitest';
import {
  formatBatchDate,
  isValidProjectNumber,
  maskProjectNumber,
  PROJECT_NUMBER_DIGITS,
  PROJECT_NUMBER_PLACEHOLDER,
} from '../src/index';

describe('maskProjectNumber', () => {
  it('inserts the dashes as digits arrive', () => {
    expect(maskProjectNumber('1')).toBe('1');
    expect(maskProjectNumber('123456')).toBe('123456');
    expect(maskProjectNumber('1234567')).toBe('123456-7');
    expect(maskProjectNumber('123456789')).toBe('123456-789');
    expect(maskProjectNumber('1234567891')).toBe('123456-789-1');
    expect(maskProjectNumber('123456789123')).toBe('123456-789-1-23');
  });

  it('drops non-digits rather than letting them into the value', () => {
    expect(maskProjectNumber('12a34b56')).toBe('123456');
    expect(maskProjectNumber('PRJ-0001')).toBe('0001');
  });

  it('is idempotent, so a paste of a formatted number survives unchanged', () => {
    const formatted = '123456-789-1-23';
    expect(maskProjectNumber(formatted)).toBe(formatted);
    expect(maskProjectNumber(maskProjectNumber(formatted))).toBe(formatted);
  });

  it('cannot grow past a complete number', () => {
    expect(maskProjectNumber('1234567891234567')).toBe('123456-789-1-23');
    expect(PROJECT_NUMBER_DIGITS).toBe(12);
  });

  it('leaves a partially deleted value in a re-maskable state', () => {
    // Backspacing through a dash must not strand the field: the mask re-derives the
    // whole string from its digits, so the dash simply disappears with the group.
    expect(maskProjectNumber('123456-789-1-2')).toBe('123456-789-1-2');
    expect(maskProjectNumber('123456-789-1-')).toBe('123456-789-1');
    expect(maskProjectNumber('123456-789-')).toBe('123456-789');
  });
});

describe('isValidProjectNumber', () => {
  it('accepts exactly the documented shape', () => {
    expect(isValidProjectNumber('123456-789-1-23')).toBe(true);
    expect(isValidProjectNumber(PROJECT_NUMBER_PLACEHOLDER)).toBe(true);
  });

  it('rejects the old free-text numbers and every near miss', () => {
    for (const bad of [
      'PRJ-0001',
      '12345-789-1-23', // 5 in the first group
      '1234567-789-1-23', // 7
      '123456-78-1-23',
      '123456-789-12-3', // groups shifted
      '123456-789-1-234',
      '123456789123', // unformatted
      '123456 789 1 23',
      '12345A-789-1-23',
      '',
    ]) {
      expect(isValidProjectNumber(bad), bad).toBe(false);
    }
  });

  it('agrees with the mask: a complete masked value always validates', () => {
    expect(isValidProjectNumber(maskProjectNumber('987654321098'))).toBe(true);
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
