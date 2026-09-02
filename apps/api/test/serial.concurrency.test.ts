import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma, Prisma } from '../src/db.js';
import { allocateSerials } from '../src/services/serial.js';

const RC = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  timeout: 20_000,
  maxWait: 15_000,
} as const;

beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE "SerialSequence"');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('allocateSerials — concurrency', () => {
  it('20 concurrent allocations on one (prefix, year): unique + contiguous + well-formed', async () => {
    const counts = [3, 5, 7, 2, 9, 4, 6, 1, 8, 5, 3, 7, 2, 6, 4, 9, 1, 8, 5, 3]; // sum = 98
    const total = counts.reduce((a, b) => a + b, 0);

    const spans = await Promise.all(
      counts.map((c) => prisma.$transaction((tx) => allocateSerials(tx, 'NIT', 2026, c), RC)),
    );

    const all = spans.flat();
    expect(all.length).toBe(total);
    expect(new Set(all).size).toBe(all.length); // globally unique
    for (const s of all) expect(s).toMatch(/^NIT26-\d{3,}$/); // well-formed

    const seqs = all.map((s) => Number(s.split('-')[1])).sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    seqs.forEach((n, i) => expect(n).toBe(i + 1)); // contiguous 1..N, no gap

    for (const span of spans) {
      const ns = span.map((s) => Number(s.split('-')[1]));
      ns.forEach((n, i) => {
        if (i > 0) expect(n).toBe(ns[i - 1]! + 1); // each tx's own span is ascending-contiguous
      });
    }

    const row = await prisma.serialSequence.findUnique({
      where: { prefix_year: { prefix: 'NIT', year: 2026 } },
    });
    expect(row?.lastSeq).toBe(total);
    expect(typeof row?.lastSeq).toBe('number');
  });

  it('separate (prefix, year) counters do not interfere', async () => {
    const [nit, arg] = await Promise.all([
      prisma.$transaction((tx) => allocateSerials(tx, 'NIT', 2026, 3), RC),
      prisma.$transaction((tx) => allocateSerials(tx, 'ARG', 2026, 3), RC),
    ]);
    expect(nit).toEqual(['NIT26-001', 'NIT26-002', 'NIT26-003']);
    expect(arg).toEqual(['ARG26-001', 'ARG26-002', 'ARG26-003']);
  });
});
