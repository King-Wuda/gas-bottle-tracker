/**
 * The History feed — a chronology of CHANGES, assembled from the records that already
 * describe them.
 *
 * There is no event-log table. The five kinds of row come from `Batch` (created),
 * `BatchInitialization`, `Transfer`, `ReturnRecord` and `BatchAmendment`, and are
 * merged and sorted on read. That is a deliberate trade: a log table would be one
 * query instead of five, but it would also be a second source of truth, and the first
 * time a route wrote the record and not the log entry — or wrote them in a
 * transaction that half-committed — History would start confidently describing things
 * that did not happen. Deriving means the feed cannot disagree with the records it
 * describes, and cannot be doctored without doctoring those records (which itself
 * writes a `BatchAmendment`, and so appears here as another row).
 *
 * The cost is bounded on purpose: each source is capped at the requested limit before
 * merging, so the worst case is five indexed queries of at most 200 rows, and the
 * merge is over at most 1000 items in memory. It is a field app for one company's
 * yard, not a public timeline.
 */
import {
  summariseLines,
  type AmendmentChange,
  type BatchEventDetail,
  type BatchEventKind,
  type BatchEventSummary,
} from '@gct/shared';
import { prisma, Prisma } from '../db.js';
import { toPhotoDto, type PhotoRow } from './photoView.js';

/** A NULL destination site means Stores — the only non-Site location. */
const STORES = 'Stores';

/** Enough batch context to caption a row without a second request. */
const batchContext = {
  id: true,
  projectId: true,
  siteId: true,
  project: { select: { projectNumber: true } },
  site: { select: { name: true } },
  lines: {
    select: { quantity: true, gasType: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const;

type BatchContextRow = {
  id: string;
  projectId: string;
  project: { projectNumber: string };
  site: { name: string };
  lines: { quantity: number; gasType: { name: string } }[];
};

const contextFields = (b: BatchContextRow) => ({
  batchId: b.id,
  projectId: b.projectId,
  projectNumber: b.project.projectNumber,
  siteName: b.site.name,
  contents: summariseLines(
    b.lines.map((l) => ({ quantity: l.quantity, gasTypeName: l.gasType.name })),
  ),
});

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** `KIND:recordId` — unique across five tables with independent id spaces. */
export const eventId = (kind: BatchEventKind, recordId: string): string => `${kind}:${recordId}`;

const photoFields = (photo: PhotoRow | null, photoOverridden: boolean) => ({
  hasPhoto: photo !== null,
  photoOverridden,
});

/**
 * Which batches the free-text query matches. Resolved to a list of ids ONCE rather
 * than repeated as a nested relation filter in all five source queries — the five
 * would each plan their own join, and the answer must be identical for all of them or
 * the merged feed would show a transfer whose batch's creation row is missing.
 */
async function matchingBatchIds(q: string | undefined): Promise<string[] | null> {
  const search = q?.trim();
  if (!search) return null;
  const rows = await prisma.batch.findMany({
    where: {
      OR: [
        { project: { is: { projectNumber: { contains: search, mode: 'insensitive' } } } },
        { projectManager: { is: { name: { contains: search, mode: 'insensitive' } } } },
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

interface FeedArgs {
  q?: string;
  batchId?: string;
  kind?: BatchEventKind;
  limit: number;
}

export async function historyFeed(
  args: FeedArgs,
): Promise<{ events: BatchEventSummary[]; truncated: boolean }> {
  const matched = await matchingBatchIds(args.q);
  // A search that matched nothing is not the same as no search: it must return an
  // empty feed, not the whole system's.
  if (matched !== null && matched.length === 0) return { events: [], truncated: false };

  const batchFilter: Prisma.BatchWhereInput = {};
  if (args.batchId) batchFilter.id = args.batchId;
  if (matched) batchFilter.id = args.batchId ? args.batchId : { in: matched };

  const scoped = <T extends { batchId?: unknown }>(
    where: T,
  ): T & { batch: typeof batchFilter } => ({
    ...where,
    batch: batchFilter,
  });

  const take = args.limit;
  const want = (kind: BatchEventKind): boolean => !args.kind || args.kind === kind;

  const [created, initialized, transfers, returns, amendments] = await Promise.all([
    want('CREATED')
      ? prisma.batch.findMany({
          where: batchFilter,
          select: {
            ...batchContext,
            createdAt: true,
            createdByUserId: true,
            createdBy: { select: { name: true } },
            _count: { select: { cylinders: true } },
          },
          orderBy: { createdAt: 'desc' },
          take,
        })
      : [],
    want('INITIALIZED')
      ? prisma.batchInitialization.findMany({
          where: scoped({}),
          select: {
            id: true,
            createdAt: true,
            userId: true,
            photoOverridden: true,
            user: { select: { name: true } },
            batch: { select: batchContext },
            photo: { include: { user: { select: { name: true } } } },
            _count: { select: { movementEvents: true } },
            movementEvents: { where: { overridden: true }, select: { id: true } },
          },
          orderBy: { createdAt: 'desc' },
          take,
        })
      : [],
    want('TRANSFER')
      ? prisma.transfer.findMany({
          where: scoped({}),
          select: {
            id: true,
            createdAt: true,
            userId: true,
            photoOverridden: true,
            destinationSiteId: true,
            user: { select: { name: true } },
            destinationSite: { select: { name: true } },
            batch: { select: batchContext },
            photo: { include: { user: { select: { name: true } } } },
            _count: { select: { movementEvents: true } },
            movementEvents: { where: { overridden: true }, select: { id: true } },
          },
          orderBy: { createdAt: 'desc' },
          take,
        })
      : [],
    want('RETURN')
      ? prisma.returnRecord.findMany({
          where: scoped({}),
          select: {
            id: true,
            createdAt: true,
            storesManagerId: true,
            driverName: true,
            photoOverridden: true,
            storesManager: { select: { name: true } },
            batch: { select: batchContext },
            photo: { include: { user: { select: { name: true } } } },
            _count: { select: { movementEvents: true } },
            movementEvents: { where: { overridden: true }, select: { id: true } },
          },
          orderBy: { createdAt: 'desc' },
          take,
        })
      : [],
    want('AMENDED')
      ? prisma.batchAmendment.findMany({
          where: scoped({}),
          select: {
            id: true,
            createdAt: true,
            userId: true,
            changes: true,
            reason: true,
            user: { select: { name: true } },
            batch: { select: batchContext },
          },
          orderBy: { createdAt: 'desc' },
          take,
        })
      : [],
  ]);

  const rows: BatchEventSummary[] = [
    ...created.map((b) => ({
      id: eventId('CREATED', b.id),
      kind: 'CREATED' as const,
      recordId: b.id,
      at: b.createdAt.toISOString(),
      ...contextFields(b),
      userId: b.createdByUserId,
      userName: b.createdBy.name,
      headline: `Batch created — ${plural(b._count.cylinders, 'cylinder')}`,
      detail: `Serials allocated and the QR sheet queued for ${b.site.name}.`,
      cylinderCount: b._count.cylinders,
      overriddenCount: 0,
      // A batch is created at a desk from a delivery note, not in front of the
      // cylinders — there is nothing to photograph yet. That is why initialization
      // exists as a separate step, and why this row is not "missing" a photo.
      hasPhoto: false,
      photoOverridden: false,
    })),
    ...initialized.map((i) => ({
      id: eventId('INITIALIZED', i.id),
      kind: 'INITIALIZED' as const,
      recordId: i.id,
      at: i.createdAt.toISOString(),
      ...contextFields(i.batch),
      userId: i.userId,
      userName: i.user.name,
      headline: `Batch initialized — ${plural(i._count.movementEvents, 'cylinder')} scanned in`,
      detail: `Labels verified at ${i.batch.site.name}.`,
      cylinderCount: i._count.movementEvents,
      overriddenCount: i.movementEvents.length,
      ...photoFields(i.photo, i.photoOverridden),
    })),
    ...transfers.map((t) => ({
      id: eventId('TRANSFER', t.id),
      kind: 'TRANSFER' as const,
      recordId: t.id,
      at: t.createdAt.toISOString(),
      ...contextFields(t.batch),
      userId: t.userId,
      userName: t.user.name,
      headline: `${plural(t._count.movementEvents, 'cylinder')} moved to ${
        t.destinationSite?.name ?? STORES
      }`,
      detail: t.destinationSiteId
        ? `Transferred to site ${t.destinationSite?.name ?? ''}.`
        : 'Returned to the depot.',
      cylinderCount: t._count.movementEvents,
      overriddenCount: t.movementEvents.length,
      ...photoFields(t.photo, t.photoOverridden),
    })),
    ...returns.map((r) => ({
      id: eventId('RETURN', r.id),
      kind: 'RETURN' as const,
      recordId: r.id,
      at: r.createdAt.toISOString(),
      ...contextFields(r.batch),
      userId: r.storesManagerId,
      userName: r.storesManager.name,
      headline: `${plural(r._count.movementEvents, 'cylinder')} returned to supplier`,
      detail: `Collected by ${r.driverName}, signed for on device.`,
      cylinderCount: r._count.movementEvents,
      overriddenCount: r.movementEvents.length,
      ...photoFields(r.photo, r.photoOverridden),
    })),
    ...amendments.map((a) => {
      const changes = parseChanges(a.changes);
      return {
        id: eventId('AMENDED', a.id),
        kind: 'AMENDED' as const,
        recordId: a.id,
        at: a.createdAt.toISOString(),
        ...contextFields(a.batch),
        userId: a.userId,
        userName: a.user.name,
        headline: `Details corrected by an admin — ${plural(changes.length, 'field')}`,
        detail: changes.map(renderChange).join(' · ') || 'No field values changed.',
        cylinderCount: 0,
        overriddenCount: 0,
        hasPhoto: false,
        photoOverridden: false,
      };
    }),
  ];

  // Newest first. `at` alone is ambiguous when a batch is created and initialized in
  // the same millisecond by a test or a fast operator, so the id breaks the tie and
  // keeps the order stable across requests instead of reshuffling on refresh.
  rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));

  return { events: rows.slice(0, take), truncated: rows.length > take };
}

/** `BatchAmendment.changes` is `Json`, so it is validated rather than cast. */
function parseChanges(raw: unknown): AmendmentChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c): AmendmentChange[] => {
    if (typeof c !== 'object' || c === null) return [];
    const { field, from, to } = c as Record<string, unknown>;
    if (typeof field !== 'string') return [];
    return [
      {
        field,
        from: from === null || from === undefined ? null : String(from),
        to: to === null || to === undefined ? null : String(to),
      },
    ];
  });
}

const renderChange = (c: AmendmentChange): string =>
  `${c.field}: ${c.from ?? '—'} → ${c.to ?? '—'}`;

// ---------------------------------------------------------------- one event

/**
 * The full record behind one row, including every serial it touched.
 *
 * Split from the feed rather than inlined into it because a batch can hold 500
 * cylinders: a 100-row feed carrying every serial of every event would be megabytes,
 * to render a list most of which nobody scrolls to.
 */
export async function historyEvent(
  kind: BatchEventKind,
  recordId: string,
): Promise<BatchEventDetail | null> {
  const [summary] = (await historyFeedForRecord(kind, recordId)) ?? [];
  if (!summary) return null;

  const base: BatchEventDetail = {
    ...summary,
    serials: [],
    overriddenSerials: [],
    photo: null,
    destinationName: null,
    driverName: null,
    changes: [],
    reason: null,
  };

  if (kind === 'CREATED') {
    const cylinders = await prisma.cylinder.findMany({
      where: { batchId: recordId },
      select: { serialCode: true },
      orderBy: { serialCode: 'asc' },
    });
    return { ...base, serials: cylinders.map((c) => c.serialCode) };
  }

  if (kind === 'AMENDED') {
    const amendment = await prisma.batchAmendment.findUnique({
      where: { id: recordId },
      select: { changes: true, reason: true },
    });
    return {
      ...base,
      changes: parseChanges(amendment?.changes),
      reason: amendment?.reason ?? null,
    };
  }

  // The three scan-backed kinds share a shape: movement events name the serials, and
  // the photo hangs off the record.
  const link =
    kind === 'INITIALIZED'
      ? { initializationId: recordId }
      : kind === 'TRANSFER'
        ? { transferId: recordId }
        : { returnRecordId: recordId };

  const [events, photo] = await Promise.all([
    prisma.movementEvent.findMany({
      where: link,
      select: { overridden: true, cylinder: { select: { serialCode: true } } },
      orderBy: { cylinder: { serialCode: 'asc' } },
    }),
    prisma.batchPhoto.findFirst({ where: link, include: { user: { select: { name: true } } } }),
  ]);

  const extra =
    kind === 'TRANSFER'
      ? await prisma.transfer
          .findUnique({
            where: { id: recordId },
            select: { destinationSite: { select: { name: true } } },
          })
          .then((t) => ({ destinationName: t ? (t.destinationSite?.name ?? STORES) : null }))
      : kind === 'RETURN'
        ? await prisma.returnRecord
            .findUnique({ where: { id: recordId }, select: { driverName: true } })
            .then((r) => ({ driverName: r?.driverName ?? null }))
        : {};

  return {
    ...base,
    serials: events.map((e) => e.cylinder.serialCode),
    overriddenSerials: events.filter((e) => e.overridden).map((e) => e.cylinder.serialCode),
    photo: photo ? toPhotoDto(photo) : null,
    ...extra,
  };
}

/**
 * One row, built by the same code that builds the feed.
 *
 * Re-running the feed narrowed to a single record is deliberately not "wasteful but
 * simpler" — it is what guarantees the detail screen's header says exactly what the
 * row the user tapped said. A second, hand-written summariser for the detail path is
 * how the two drift into disagreeing about the same event.
 */
async function historyFeedForRecord(
  kind: BatchEventKind,
  recordId: string,
): Promise<BatchEventSummary[] | null> {
  const batchId =
    kind === 'CREATED'
      ? recordId
      : await ownerBatchId(kind, recordId).then((id) => id ?? undefined);
  if (!batchId) return null;

  const { events } = await historyFeed({ batchId, kind, limit: 200 });
  const match = events.find((e) => e.recordId === recordId);
  return match ? [match] : null;
}

async function ownerBatchId(kind: BatchEventKind, recordId: string): Promise<string | null> {
  const select = { batchId: true } as const;
  const row =
    kind === 'INITIALIZED'
      ? await prisma.batchInitialization.findUnique({ where: { id: recordId }, select })
      : kind === 'TRANSFER'
        ? await prisma.transfer.findUnique({ where: { id: recordId }, select })
        : kind === 'RETURN'
          ? await prisma.returnRecord.findUnique({ where: { id: recordId }, select })
          : await prisma.batchAmendment.findUnique({ where: { id: recordId }, select });
  return row?.batchId ?? null;
}
