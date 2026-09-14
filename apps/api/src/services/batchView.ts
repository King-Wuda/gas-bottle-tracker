/**
 * How a Batch becomes a DTO — including the per-gas location breakdown that every
 * batch row now shows.
 *
 * Shared by the list, the detail view, the admin console and the transfer/return
 * confirmations, because "where is this batch?" must read the same everywhere. It
 * lives here rather than in `routes/batches.ts` so the four callers cannot drift into
 * four slightly different answers.
 */
import type {
  BatchDistributionEntry,
  BatchDto,
  BatchLineDto,
  BatchSummary,
  EmailDelivery,
} from '@gct/shared';
import { prisma } from '../db.js';

/** A NULL `currentSiteId` means the depot; there is no Site row for it. */
export const STORES_LABEL = 'Stores';

export type BatchLineRow = {
  id: string;
  gasTypeId: string;
  supplierId: string | null;
  supplierName: string;
  quantity: number;
  initialDeliveryPoint: string;
  gasType: { name: string };
};

export type CylinderRow = {
  id: string;
  serialCode: string;
  status: BatchDto['cylinders'][number]['status'];
  gasTypeId: string;
  batchLineId: string;
  currentSiteId: string | null;
};

export type BatchCoreRow = {
  id: string;
  projectId: string;
  siteId: string;
  projectManagerId: string;
  projectManagerEmail: string;
  status: BatchDto['status'];
  createdAt: Date;
  initializedAt: Date | null;
  transferredAt: Date | null;
  returnedAt: Date | null;
  emailSentAt: Date | null;
  lastEmailSentAt: Date | null;
  resendCount: number;
  project: { projectNumber: string };
  projectManager: { name: string };
  /** The client owns the name; the site owns the place. See the Site model. */
  site: { location: string; client: { name: string } };
  lines: BatchLineRow[];
};

/**
 * Every batch view carries the project number, manager, site and its lines: the
 * Transfer / Returns / History rows all show them, and fetching them per row from the
 * client would be N+1 over a list that is already the app's busiest screen.
 */
export const batchRelations = {
  project: { select: { projectNumber: true } },
  projectManager: { select: { name: true } },
  // `siteName` in the DTO is the CLIENT's name and `siteLocation` the site's own —
  // the two halves an operator types as "Site" and "Location". Kept under those DTO
  // names so the delivery note, the QR sheet and every history screen read unchanged.
  site: { select: { location: true, client: { select: { name: true } } } },
  lines: {
    select: {
      id: true,
      gasTypeId: true,
      supplierId: true,
      supplierName: true,
      quantity: true,
      initialDeliveryPoint: true,
      gasType: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
} as const;

export const batchInclude = { ...batchRelations, cylinders: true } as const;

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export const toLineDto = (l: BatchLineRow): BatchLineDto => ({
  id: l.id,
  gasTypeId: l.gasTypeId,
  gasTypeName: l.gasType.name,
  supplierId: l.supplierId,
  supplierName: l.supplierName,
  quantity: l.quantity,
  initialDeliveryPoint: l.initialDeliveryPoint,
});

export const sortBySerial = <T extends { serialCode: string }>(cs: T[]): T[] =>
  [...cs].sort((a, b) => a.serialCode.localeCompare(b.serialCode, 'en', { numeric: true }));

// ------------------------- the location breakdown -------------------------

/** One `GROUP BY` row: how many cylinders of one gas sit in one place. */
interface DistributionRow {
  batchId: string;
  gasTypeId: string;
  currentSiteId: string | null;
  returned: boolean;
  count: number;
}

/**
 * "Of the 7 nitrogen in this batch, 3 are at Stores and 4 went to Yard B."
 *
 * Computed from the cylinders on every read rather than stored on the batch. The
 * cylinders ARE the record of where things are; a cached copy of this would be a
 * second source of truth, and the first time a transfer updated one and not the other
 * the app would start confidently reporting a location nothing is actually in.
 *
 * One query for every batch on the page — the alternative is 200 round trips on the
 * busiest screen in the app.
 */
export async function distributionFor(
  batchIds: string[],
): Promise<Map<string, BatchDistributionEntry[]>> {
  const out = new Map<string, BatchDistributionEntry[]>();
  if (batchIds.length === 0) return out;

  const grouped = await prisma.cylinder.groupBy({
    by: ['batchId', 'gasTypeId', 'currentSiteId', 'status'],
    where: { batchId: { in: batchIds } },
    _count: { _all: true },
  });

  // A returned cylinder is nowhere — its currentSiteId is NULL, same as a cylinder
  // sitting at stores. Collapsing the two would report returned stock as available,
  // so status is what separates them, not location.
  const rows: DistributionRow[] = grouped.map((g) => ({
    batchId: g.batchId,
    gasTypeId: g.gasTypeId,
    currentSiteId: g.currentSiteId,
    returned: g.status === 'RETURNED',
    count: g._count._all,
  }));

  const siteIds = [...new Set(rows.map((r) => r.currentSiteId).filter((s): s is string => !!s))];
  const [sites, gasTypes] = await Promise.all([
    siteIds.length > 0
      ? // Within one batch the client is constant, so the useful label for "where are
        // these cylinders" is the place — Durban — not the client who owns it.
        prisma.site.findMany({
          where: { id: { in: siteIds } },
          select: { id: true, location: true },
        })
      : Promise.resolve([]),
    prisma.gasType.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.gasTypeId))] } },
      select: { id: true, name: true },
    }),
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.location]));
  const gasName = new Map(gasTypes.map((g) => [g.id, g.name]));

  // Merge the RETURNED rows of one gas together: which site a cylinder was collected
  // from is the movement log's question, not this one's.
  const merged = new Map<string, BatchDistributionEntry>();
  for (const r of rows) {
    const kind = r.returned ? 'RETURNED' : r.currentSiteId ? 'SITE' : 'STORES';
    const siteId = kind === 'SITE' ? r.currentSiteId : null;
    const key = `${r.batchId}|${r.gasTypeId}|${kind}|${siteId ?? ''}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count += r.count;
      continue;
    }
    merged.set(key, {
      gasTypeId: r.gasTypeId,
      gasTypeName: gasName.get(r.gasTypeId) ?? 'Gas',
      kind,
      siteId,
      locationName:
        kind === 'RETURNED'
          ? 'Returned'
          : kind === 'STORES'
            ? STORES_LABEL
            : (siteName.get(siteId!) ?? 'Site'),
      count: r.count,
    });
  }

  for (const [key, entry] of merged) {
    const batchId = key.slice(0, key.indexOf('|'));
    const list = out.get(batchId);
    if (list) list.push(entry);
    else out.set(batchId, [entry]);
  }
  return out;
}

// ------------------------- DTO assembly -------------------------

type BatchBase = Omit<BatchSummary, 'cylinderCount' | 'returnedCount'>;

export function toBatchBase(b: BatchCoreRow, distribution: BatchDistributionEntry[]): BatchBase {
  return {
    id: b.id,
    projectId: b.projectId,
    projectNumber: b.project.projectNumber,
    projectManagerId: b.projectManagerId,
    projectManagerName: b.projectManager.name,
    projectManagerEmail: b.projectManagerEmail,
    siteId: b.siteId,
    siteName: b.site.client.name,
    siteLocation: b.site.location,
    quantity: b.lines.reduce((n, l) => n + l.quantity, 0),
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    initializedAt: iso(b.initializedAt),
    transferredAt: iso(b.transferredAt),
    returnedAt: iso(b.returnedAt),
    emailSentAt: iso(b.emailSentAt),
    lastEmailSentAt: iso(b.lastEmailSentAt),
    resendCount: b.resendCount,
    lines: b.lines.map(toLineDto),
    distribution,
  };
}

export function toBatchDto(
  b: BatchCoreRow & { cylinders: CylinderRow[] },
  distribution: BatchDistributionEntry[],
): BatchDto {
  return {
    ...toBatchBase(b, distribution),
    cylinders: sortBySerial(b.cylinders).map((c) => ({
      id: c.id,
      serialCode: c.serialCode,
      status: c.status,
      gasTypeId: c.gasTypeId,
      batchLineId: c.batchLineId,
      currentSiteId: c.currentSiteId,
    })),
  };
}

/**
 * What became of the QR-sheet mail for one batch — the newest outbox row for it.
 *
 * Newest rather than first because "Resend email" writes another row: the question the
 * screen is asking is "did the last attempt land?", and the original PENDING row from
 * three days ago is not the answer to it.
 *
 * Matched through the payload's `batchId` rather than a foreign key. `OutboundEmail`
 * deliberately holds a render context instead of a relation to every kind of thing it
 * can be about (a DELIVERY_NOTE row points at a return, not a batch), and a column per
 * type would have to grow every time a new mail is added. The table is small and the
 * detail screen asks for exactly one batch, so a JSON path lookup is the cheaper trade.
 *
 * Detail-only, and not part of `BatchSummary`: the history list renders hundreds of
 * rows, and this would be a query per row for a fact nobody reads from a list.
 */
export async function emailDeliveryFor(batchId: string): Promise<EmailDelivery | null> {
  const row = await prisma.outboundEmail.findFirst({
    where: { type: 'QR_SHEET', payload: { path: ['batchId'], equals: batchId } },
    orderBy: { createdAt: 'desc' },
    select: { status: true, lastError: true, attempts: true, sentAt: true, to: true },
  });
  if (!row) return null;
  return {
    status: row.status,
    lastError: row.lastError,
    attempts: row.attempts,
    sentAt: iso(row.sentAt),
    to: row.to,
  };
}

/** Load one batch and its breakdown together — the shape both detail paths need. */
export async function loadBatchDto(batchId: string): Promise<BatchDto | null> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId }, include: batchInclude });
  if (!batch) return null;
  const dist = await distributionFor([batchId]);
  return toBatchDto(batch, dist.get(batchId) ?? []);
}
