import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FakeClock, serialYear, formatSerial } from '@gct/shared';
import { prisma } from '../src/db.js';
import { allocateSerials } from '../src/services/serial.js';

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "SerialSequence"');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('serial year rollover', () => {
  it('year rolls at local midnight; seq restarts for the new (prefix, year)', async () => {
    const tz = 'Africa/Johannesburg'; // UTC+2, no DST
    const clock = new FakeClock('2026-12-31T21:59:00Z'); // 23:59 local
    expect(serialYear(clock, tz)).toBe(2026);

    const a = await prisma.$transaction((tx) =>
      allocateSerials(tx, 'NIT', serialYear(clock, tz), 2),
    );
    expect(a).toEqual(['NIT26-001', 'NIT26-002']);

    clock.advance(2 * 60_000); // 00:01 local, 2027
    expect(serialYear(clock, tz)).toBe(2027);

    const b = await prisma.$transaction((tx) =>
      allocateSerials(tx, 'NIT', serialYear(clock, tz), 2),
    );
    expect(b).toEqual(['NIT27-001', 'NIT27-002']);

    const r26 = await prisma.serialSequence.findUnique({
      where: { prefix_year: { prefix: 'NIT', year: 2026 } },
    });
    expect(r26?.lastSeq).toBe(2); // untouched
  });

  it('serialYear is tz-deterministic at a UTC boundary', () => {
    const c = new FakeClock('2026-12-31T23:30:00Z');
    expect(serialYear(c, 'America/New_York')).toBe(2026); // 18:30 local
    expect(serialYear(c, 'Pacific/Kiritimati')).toBe(2027); // +14 -> next day
  });

  it('zero-pads to 3, widens past 999, never wraps', async () => {
    await prisma.serialSequence.create({ data: { prefix: 'NIT', year: 2026, lastSeq: 998 } });
    const s = await prisma.$transaction((tx) => allocateSerials(tx, 'NIT', 2026, 4));
    expect(s).toEqual(['NIT26-999', 'NIT26-1000', 'NIT26-1001', 'NIT26-1002']);
  });

  it('formatSerial units', () => {
    expect(formatSerial('NIT', 2026, 1)).toBe('NIT26-001');
    expect(formatSerial('NIT', 2026, 42)).toBe('NIT26-042');
    expect(formatSerial('NIT', 2026, 999)).toBe('NIT26-999');
    expect(formatSerial('NIT', 2026, 1000)).toBe('NIT26-1000');
    expect(formatSerial('CO2', 2030, 12345)).toBe('CO230-12345');
    expect(() => formatSerial('NIT', 2026, 0)).toThrow();
  });
});
