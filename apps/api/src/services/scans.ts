/**
 * Scan resolution — shared by Workflow B (transfers) and Workflow C (returns).
 *
 * Turns a list of raw device scans into (a) the cylinder rows that may legally move
 * and (b) a PER-SERIAL rejection list. Rejections are per-serial by design: a driver
 * who scans one cylinder from the wrong pallet should see exactly which one failed,
 * not a blanket 400 for the whole submission.
 *
 * This function only READS. It is deliberately not the enforcement point for
 * concurrent movement — the caller's single atomic UPDATE is (see routes/transfers).
 */
import type { CylinderStatus, ScanInput, ScanRejection, ScanRejectionCode } from '@gct/shared';
import type { Prisma } from '../db.js';
import { verifyScannedPayload } from './qr.js';

export interface ResolvedCylinder {
  id: string;
  serialCode: string;
  status: CylinderStatus;
  currentSiteId: string | null;
  /** Device clock at the moment this cylinder was scanned. */
  scannedAt: Date;
  /** TRUE when an admin asserted this cylinder rather than scanning it. Carried all
   *  the way to `MovementEvent.overridden` so the trail says which kind of evidence
   *  it holds. */
  overridden: boolean;
}

export interface ScanResolution {
  accepted: ResolvedCylinder[];
  rejected: ScanRejection[];
}

const reject = (serialCode: string, code: ScanRejectionCode, message: string): ScanRejection => ({
  serialCode,
  code,
  message,
});

export interface ResolveOptions {
  /**
   * Refuse every serial when the batch has never been initialized.
   *
   * A cylinder whose printed label was never scanned back off it cannot honestly be
   * scanned onto a truck, so a transfer or return of an uninitialized batch could only
   * ever have been an assertion. Default TRUE, because that is right for every caller
   * except the one that LIFTS the gate — `routes/initializations.ts` passes false,
   * since requiring initialization to initialize would be a deadlock.
   */
  requireInitialized?: boolean;
}

/**
 * @param batchId  the batch the user selected — a scan for any other batch is rejected
 *                 rather than silently moved (Workflow B acts on ONE active batch).
 * @param overrideSerials  serials an ADMIN asserted without scanning. The caller is
 *                 responsible for having checked the role FIRST; this function
 *                 assumes that check has passed. They skip signature verification —
 *                 that is the whole point of an override — but every other rule
 *                 (exists, right batch, not already returned) still applies, because
 *                 those protect the data rather than prove physical presence.
 */
export async function resolveScans(
  tx: Prisma.TransactionClient,
  batchId: string,
  scans: ScanInput[],
  overrideSerials: string[] = [],
  options: ResolveOptions = {},
): Promise<ScanResolution> {
  const { requireInitialized = true } = options;
  const rejected: ScanRejection[] = [];
  const candidates = new Map<string, { scannedAt: Date; overridden: boolean }>();

  for (const scan of scans) {
    if (candidates.has(scan.serialCode)) {
      rejected.push(
        reject(scan.serialCode, 'DUPLICATE_SCAN', 'This cylinder was scanned more than once.'),
      );
      continue;
    }

    const verified = verifyScannedPayload(scan.qrPayload);
    if (!verified.ok) {
      rejected.push(
        reject(
          scan.serialCode,
          'BAD_QR_SIGNATURE',
          `QR code failed verification (${verified.reason}). It was not issued by this system.`,
        ),
      );
      continue;
    }
    if (verified.serialCode !== scan.serialCode) {
      rejected.push(
        reject(
          scan.serialCode,
          'SERIAL_MISMATCH',
          `The scanned label encodes ${verified.serialCode}, not ${scan.serialCode}.`,
        ),
      );
      continue;
    }

    candidates.set(scan.serialCode, { scannedAt: new Date(scan.scannedAt), overridden: false });
  }

  // A serial that was genuinely scanned AND also listed as an override keeps the
  // scan: real evidence outranks an assertion, and quietly downgrading it would
  // understate what the operator actually did.
  const overrideAt = new Date();
  for (const serialCode of overrideSerials) {
    if (candidates.has(serialCode)) continue;
    candidates.set(serialCode, { scannedAt: overrideAt, overridden: true });
  }

  if (candidates.size === 0) return { accepted: [], rejected };

  // Read through the transaction, alongside the cylinders, so a concurrent
  // initialization committing mid-request cannot leave half the serials gated and
  // half not.
  if (requireInitialized) {
    const batch = await tx.batch.findUnique({
      where: { id: batchId },
      select: { initializedAt: true },
    });
    if (batch && batch.initializedAt === null) {
      // Rejected per serial rather than as one blanket error, so the app can mark
      // every row and say the same thing about each — the shape the scan screen and
      // the outbox's rejection list already know how to render.
      for (const serialCode of candidates.keys()) {
        rejected.push(
          reject(
            serialCode,
            'NOT_INITIALIZED',
            'This batch has not been initialized yet. Scan it in first, from New → Initialize a batch.',
          ),
        );
      }
      return { accepted: [], rejected };
    }
  }

  const rows = await tx.cylinder.findMany({
    where: { serialCode: { in: [...candidates.keys()] } },
    select: { id: true, serialCode: true, status: true, currentSiteId: true, batchId: true },
  });
  const bySerial = new Map(rows.map((r) => [r.serialCode, r]));

  const accepted: ResolvedCylinder[] = [];
  for (const [serialCode, candidate] of candidates) {
    const row = bySerial.get(serialCode);
    if (!row) {
      rejected.push(
        reject(serialCode, 'UNKNOWN_SERIAL', 'No cylinder with this serial exists in the system.'),
      );
      continue;
    }
    if (row.batchId !== batchId) {
      rejected.push(
        reject(serialCode, 'WRONG_BATCH', 'This cylinder belongs to a different batch.'),
      );
      continue;
    }
    if (row.status === 'RETURNED') {
      rejected.push(
        reject(serialCode, 'ALREADY_RETURNED', 'This cylinder has already been returned.'),
      );
      continue;
    }
    accepted.push({
      id: row.id,
      serialCode: row.serialCode,
      status: row.status,
      currentSiteId: row.currentSiteId,
      scannedAt: candidate.scannedAt,
      overridden: candidate.overridden,
    });
  }

  return { accepted, rejected };
}

export { reject as scanRejection };
