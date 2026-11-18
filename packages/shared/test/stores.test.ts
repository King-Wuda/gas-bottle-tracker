import { describe, it, expect } from 'vitest';
import { driverPhoneSchema } from '../src/schemas/driver';
import { CAGES, cageSchema, gasCagesSchema } from '../src/schemas/stores';

describe('driver phone number', () => {
  it('accepts the ways a phone number is actually written', () => {
    for (const ok of ['0825550199', '082 555 0199', '+27 82 555 0199', '(011) 555-0199']) {
      expect(driverPhoneSchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('refuses empty, words and too few digits', () => {
    for (const bad of ['', '   ', 'call me', '12345', '082-55']) {
      expect(driverPhoneSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('trims what it stores', () => {
    expect(driverPhoneSchema.parse('  082 555 0199  ')).toBe('082 555 0199');
  });
});

describe('cages', () => {
  it('are 1, 2 and 3', () => {
    expect([...CAGES]).toEqual([1, 2, 3]);
    expect(cageSchema.safeParse(0).success).toBe(false);
    expect(cageSchema.safeParse(4).success).toBe(false);
    expect(cageSchema.safeParse(2.5).success).toBe(false);
  });

  it('one cage per gas — the same gas twice is refused', () => {
    expect(
      gasCagesSchema.safeParse([
        { gasTypeId: 'argon', cage: 1 },
        { gasTypeId: 'nitrogen', cage: 3 },
      ]).success,
    ).toBe(true);
    expect(
      gasCagesSchema.safeParse([
        { gasTypeId: 'argon', cage: 1 },
        { gasTypeId: 'argon', cage: 2 },
      ]).success,
    ).toBe(false);
  });
});
