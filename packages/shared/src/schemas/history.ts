import { z } from 'zod';
import { cylinderStatusSchema } from './batch';
import { batchPhotoDtoSchema } from './photo';
import { movementTypeSchema } from './transfer';

/**
 * M5/M6 audit trail. `MovementEvent` is the rental-accountability record: every hop a
 * cylinder made, who scanned it, and which Transfer or ReturnRecord it belonged to.
 * These DTOs are what the mobile history view renders.
 */

export const movementEventDtoSchema = z.object({
  id: z.string(),
  type: movementTypeSchema,
  cylinderId: z.string(),
  serialCode: z.string(),
  /** NULL site id means Stores — `fromName`/`toName` already spell that out. */
  fromSiteId: z.string().nullable(),
  fromName: z.string(),
  toSiteId: z.string().nullable(),
  toName: z.string(),
  userId: z.string(),
  userName: z.string(),
  /** At most one of these is set; all null for INTAKE. */
  transferId: z.string().nullable(),
  returnRecordId: z.string().nullable(),
  initializationId: z.string().nullable(),
  /** When the device recorded it — may predate `serverAt` by hours if captured offline. */
  deviceAt: z.string(),
  serverAt: z.string(),
});
export type MovementEventDto = z.infer<typeof movementEventDtoSchema>;

/** Enough batch context to caption a history screen without a second request. */
export const historyBatchRefSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  /** "7 × Nitrogen, 4 × Argon" — one line, because a batch can hold several gases and
   *  this is a header above a movement feed, not the batch's full record. */
  contents: z.string(),
});
export type HistoryBatchRef = z.infer<typeof historyBatchRefSchema>;

export const cylinderHistoryResponseSchema = z.object({
  cylinder: z.object({
    id: z.string(),
    serialCode: z.string(),
    status: cylinderStatusSchema,
    currentSiteId: z.string().nullable(),
    currentLocation: z.string(),
  }),
  batch: historyBatchRefSchema,
  /** Oldest first — the chain reads top-to-bottom as the cylinder's life. */
  events: z.array(movementEventDtoSchema),
});
export type CylinderHistoryResponse = z.infer<typeof cylinderHistoryResponseSchema>;

export const batchHistoryResponseSchema = z.object({
  batch: historyBatchRefSchema,
  /** Newest first — a batch activity feed, unlike the per-cylinder chain. */
  events: z.array(movementEventDtoSchema),
});
export type BatchHistoryResponse = z.infer<typeof batchHistoryResponseSchema>;

// --------------------------------------------------------------------------
// The History section proper — a feed of EVENTS, not of batches.
// --------------------------------------------------------------------------

/**
 * History answers "what happened", so its rows are things that happened.
 *
 * It used to list batches, which made it a fourth copy of the Transfer/Returns picker
 * that happened to hide nothing — and a batch is a *thing*, not a change to one. A
 * batch that was created, initialized, transferred twice and half-returned appeared
 * as one row saying only where it is now, which is the one question the other three
 * tabs already answer. The five kinds below are the changes a batch can undergo, and
 * every one of them becomes its own row, so the feed reads as a chronology.
 *
 * Nothing here is editable, by anyone. These rows are derived on read from the
 * records that already exist — `Batch`, `BatchInitialization`, `Transfer`,
 * `ReturnRecord`, `BatchAmendment` — rather than written to a log table of their own.
 * A separate log would be a second source of truth that could disagree with the
 * records it describes; deriving means the feed cannot drift from what actually
 * happened, and cannot be doctored without doctoring the underlying record (which
 * itself writes a `BatchAmendment`, and so shows up here as another row).
 */
export const batchEventKindSchema = z.enum([
  'CREATED', // the batch was booked in and its QR sheet queued
  'INITIALIZED', // the labels were scanned back off the cylinders, with a photo
  'TRANSFER', // cylinders moved between sites, or back to stores
  'RETURN', // cylinders went back to the supplier, with a driver's signature
  'AMENDED', // an admin corrected the batch's details
]);
export type BatchEventKind = z.infer<typeof batchEventKindSchema>;

export const BATCH_EVENT_LABELS: Record<BatchEventKind, string> = {
  CREATED: 'Created',
  INITIALIZED: 'Initialized',
  TRANSFER: 'Transfer',
  RETURN: 'Return',
  AMENDED: 'Amended',
};

export const batchEventSummarySchema = z.object({
  /**
   * `KIND:recordId` — unique across the five source tables, which have independent id
   * spaces. Also the address of the detail screen, so a row is linkable.
   */
  id: z.string(),
  kind: batchEventKindSchema,
  /** The record's own id within its source table. */
  recordId: z.string(),
  /** Server clock — when it was persisted. The feed sorts on this. */
  at: z.string(),

  batchId: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  siteName: z.string(),
  /** "7 × Nitrogen, 4 × Argon" — what the batch holds, for context on the row. */
  contents: z.string(),

  /** Who did it. */
  userId: z.string(),
  userName: z.string(),

  /** "5 cylinders moved to Yard B" — rendered server-side so every client agrees. */
  headline: z.string(),
  /** The second line: destination, driver, or what was corrected. */
  detail: z.string(),

  /** How many cylinders this event touched, and how many of those were unscanned. */
  cylinderCount: z.number().int().nonnegative(),
  overriddenCount: z.number().int().nonnegative(),

  /** A photo exists for this event, fetchable from the detail screen. */
  hasPhoto: z.boolean(),
  /** No photo because an admin overrode the camera — distinct from "not applicable". */
  photoOverridden: z.boolean(),
});
export type BatchEventSummary = z.infer<typeof batchEventSummarySchema>;

/** One field an admin corrected, as `BatchAmendment.changes` stores it. */
export const amendmentChangeSchema = z.object({
  field: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type AmendmentChange = z.infer<typeof amendmentChangeSchema>;

/**
 * The full record behind one row. Serials live here and not on the summary: a batch
 * can hold 500 cylinders, and a 100-row feed carrying every serial of every event
 * would be megabytes to render a list nobody has scrolled to yet.
 */
export const batchEventDetailSchema = batchEventSummarySchema.extend({
  /** Every serial this event touched, sorted. Empty for AMENDED. */
  serials: z.array(z.string()),
  /** The subset waved through without a scan. */
  overriddenSerials: z.array(z.string()),
  /** Metadata only — `GET /batch-photos/:id` returns the image itself. */
  photo: batchPhotoDtoSchema.nullable(),

  /** TRANSFER only: where the cylinders went. */
  destinationName: z.string().nullable(),
  /** RETURN only: who signed for them. */
  driverName: z.string().nullable(),
  /** RETURN only: the number off the ID they presented, where one was recorded. */
  driverIdNumber: z.string().nullable(),
  /** AMENDED only: what was changed, and why. */
  changes: z.array(amendmentChangeSchema),
  reason: z.string().nullable(),
});
export type BatchEventDetail = z.infer<typeof batchEventDetailSchema>;

/**
 * The feed query. Deliberately narrow: History is read-only and chronological, so it
 * filters by *what happened* and *which batch*, not by the gas/supplier attributes the
 * batch pickers filter on — those answer "which batch should I act on", which is not a
 * question this section is for.
 */
export const historyFeedQuerySchema = z.object({
  /** Substring match on project number or project manager name. */
  q: z.string().max(200).optional(),
  /** One batch's chronology, rather than the whole system's. */
  batchId: z.string().min(1).optional(),
  kind: batchEventKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type HistoryFeedQuery = z.infer<typeof historyFeedQuerySchema>;

export const historyFeedResponseSchema = z.object({
  /** Newest first. */
  events: z.array(batchEventSummarySchema),
  /** Rows returned, and whether the cap truncated the answer. */
  returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type HistoryFeedResponse = z.infer<typeof historyFeedResponseSchema>;

export const batchEventDetailResponseSchema = z.object({ event: batchEventDetailSchema });
export type BatchEventDetailResponse = z.infer<typeof batchEventDetailResponseSchema>;
