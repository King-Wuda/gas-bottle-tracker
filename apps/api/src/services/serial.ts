/**
 * Serial-number allocation — the one function that must not be got wrong.
 *
 * Concurrency model: a single atomic statement. `INSERT ... ON CONFLICT (prefix,year)
 * DO UPDATE SET lastSeq = lastSeq + EXCLUDED.lastSeq RETURNING lastSeq` row-locks and
 * re-reads the latest committed row even under READ COMMITTED (Postgres EvalPlanQual
 * re-check, same as SELECT ... FOR UPDATE), so N concurrent callers each compose their
 * increment onto the freshest value — no lost update, no 40001 serialization abort,
 * no race-prone "insert row if missing" pre-step.
 *
 * Guarantee: serials are globally unique and strictly monotonic ALWAYS; contiguous
 * whenever the surrounding batch transaction does not roll back. Call this as the
 * LAST write before commit so a post-allocation abort (which would burn a span and
 * leave a hole) is near-impossible. Cylinder.serialCode UNIQUE is the backstop.
 */
import { PREFIX_RE, formatSerial } from '@gct/shared';
import type { Prisma } from '../db.js';

const MAX_COUNT = 10_000;

export async function allocateSerials(
  tx: Prisma.TransactionClient,
  prefix: string,
  year: number,
  count: number,
): Promise<string[]> {
  if (!PREFIX_RE.test(prefix)) throw new Error(`allocateSerials: invalid prefix ${prefix}`);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`allocateSerials: count must be 1..${MAX_COUNT}, got ${count}`);
  }
  if (!Number.isInteger(year)) throw new Error(`allocateSerials: invalid year ${year}`);

  const rows = await tx.$queryRaw<{ lastSeq: number | bigint }[]>`
    INSERT INTO "SerialSequence" ("prefix", "year", "lastSeq")
    VALUES (${prefix}, ${year}, ${count})
    ON CONFLICT ("prefix", "year")
    DO UPDATE SET "lastSeq" = "SerialSequence"."lastSeq" + EXCLUDED."lastSeq"
    RETURNING "lastSeq"
  `;

  const end = Number(rows[0]!.lastSeq); // defensively Number() in case the column ever widens to int8
  const start = end - count + 1; // reserved span [start, end]
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) out[i] = formatSerial(prefix, year, start + i);
  return out;
}
