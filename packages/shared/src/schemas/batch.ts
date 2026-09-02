import { z } from 'zod';

export const batchStatusSchema = z.enum(['ACTIVE', 'PARTIAL', 'RETURNED']);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

export const cylinderStatusSchema = z.enum(['IN_STORES', 'DEPLOYED', 'IN_TRANSIT', 'RETURNED']);
export type CylinderStatus = z.infer<typeof cylinderStatusSchema>;

/**
 * Where the cylinders physically land when the batch is booked in. Two choices, not
 * free text: the UI renders it as a Stores/Site toggle and the DB carries a matching
 * CHECK constraint, so this enum is the middle of three agreeing definitions.
 */
export const initialDeliveryPointSchema = z.enum(['STORES', 'SITE']);
export type InitialDeliveryPoint = z.infer<typeof initialDeliveryPointSchema>;

export const INITIAL_DELIVERY_POINT_LABELS: Record<InitialDeliveryPoint, string> = {
  STORES: 'Stores',
  SITE: 'Site',
};

/**
 * One homogeneous group of cylinders inside a batch — a gas, its supplier, and how
 * many.
 *
 * A batch holds MANY of these. "Add line item" only appends to the draft; nothing is
 * created until Create batch is tapped, and what is then created is ONE batch whose
 * lines may name different gases from different suppliers. That is the physical
 * reality being modelled: a single delivery arrives with 7 nitrogen and 4 argon on
 * the same truck, against the same project, on the same day.
 */
export const batchLineInputSchema = z.object({
  gasTypeId: z.string().min(1),
  /** Chosen from the suppliers paired with `gasTypeId`; the name is resolved server-side. */
  supplierId: z.string().min(1),
  quantity: z.number().int().min(1).max(500),
  initialDeliveryPoint: initialDeliveryPointSchema,
});
export type BatchLineInput = z.infer<typeof batchLineInputSchema>;

/** Cylinders per batch, summed across its lines — the serial allocator's ceiling. */
export const MAX_BATCH_CYLINDERS = 500;
/** Distinct gas/supplier groupings one batch may carry. */
export const MAX_BATCH_LINES = 25;

export const createBatchRequestSchema = z
  .object({
    projectId: z.string().min(1),
    siteId: z.string().min(1),
    /** Device-minted idempotency key (UUID). Replaying returns the original batch. */
    clientRequestId: z.string().min(8).max(64),
    /**
     * Who the paperwork is addressed to. Optional: omitted means the project's own
     * manager, which is the normal case. Present when the operator picked someone
     * else — see `projectManagerId` on the transfer request for the same idea applied
     * to a batch that has already been created.
     */
    projectManagerId: z.string().min(1).optional(),
    lines: z.array(batchLineInputSchema).min(1).max(MAX_BATCH_LINES),
  })
  .refine((b) => b.lines.reduce((n, l) => n + l.quantity, 0) <= MAX_BATCH_CYLINDERS, {
    message: `A batch cannot hold more than ${MAX_BATCH_CYLINDERS} cylinders in total`,
    path: ['lines'],
  });
export type CreateBatchRequest = z.infer<typeof createBatchRequestSchema>;

export const batchLineDtoSchema = z.object({
  id: z.string(),
  gasTypeId: z.string(),
  gasTypeName: z.string(),
  supplierId: z.string().nullable(),
  supplierName: z.string(),
  quantity: z.number().int(),
  initialDeliveryPoint: z.string(),
});
export type BatchLineDto = z.infer<typeof batchLineDtoSchema>;

export const cylinderDtoSchema = z.object({
  id: z.string(),
  serialCode: z.string(),
  status: cylinderStatusSchema,
  gasTypeId: z.string(),
  /** Which line of the batch this cylinder was booked in under. */
  batchLineId: z.string(),
  currentSiteId: z.string().nullable(),
});
export type CylinderDto = z.infer<typeof cylinderDtoSchema>;

/**
 * Where one gas from one batch physically is, right now.
 *
 * A batch is no longer in one place. Seven nitrogen booked in together can end up as
 * "3 at Stores, 4 at Yard B" after a partial transfer, and that split is the thing the
 * Transfer / Returns / History rows have to show — a single "7 × Nitrogen" line would
 * be a statement the system cannot actually stand behind.
 *
 * Derived from `Cylinder.currentSiteId` + `Cylinder.status` on every read rather than
 * stored: the cylinders ARE the record of where things are, so any cached copy of this
 * would be a second source of truth waiting to disagree with them.
 */
export const batchLocationKindSchema = z.enum(['STORES', 'SITE', 'RETURNED']);
export type BatchLocationKind = z.infer<typeof batchLocationKindSchema>;

export const batchDistributionEntrySchema = z.object({
  gasTypeId: z.string(),
  gasTypeName: z.string(),
  kind: batchLocationKindSchema,
  /** Set only when `kind` is SITE. */
  siteId: z.string().nullable(),
  /** "Stores", the site's name, or "Returned" — ready to render. */
  locationName: z.string(),
  count: z.number().int().nonnegative(),
});
export type BatchDistributionEntry = z.infer<typeof batchDistributionEntrySchema>;

const batchCoreSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  projectManagerId: z.string(),
  projectManagerName: z.string(),
  /**
   * The address this batch's paperwork goes to, held on the batch rather than read
   * live through the project. Correcting a manager's address on their own record must
   * not silently rewrite where last month's QR sheet actually went; deliberately
   * reassigning the batch to a different manager (on transfer, or by an admin) does
   * move it, because that is the whole point of the reassignment.
   */
  projectManagerEmail: z.string(),
  siteId: z.string(),
  siteName: z.string(),
  /** Printed on every QR label, so it travels with the batch rather than being looked up. */
  siteLocation: z.string(),
  /** Total cylinders across every line — the sum the header shows. */
  quantity: z.number().int(),
  status: batchStatusSchema,
  createdAt: z.string(),
  /**
   * When the batch's labels were scanned back off the cylinders for the first time.
   * Null means it has not happened yet, and until it does the batch cannot be
   * transferred or returned — see `schemas/initialization.ts` for why.
   */
  initializedAt: z.string().nullable(),
  /** First transfer / full return. Null means it has not happened — this pair drives
   *  the status badges and the audit trail, and no longer hides rows from any tab:
   *  a transferred batch can always be transferred again. */
  transferredAt: z.string().nullable(),
  returnedAt: z.string().nullable(),
  /** First successful queue of the QR-sheet mail, and the most recent send of any
   *  kind. The 60s resend lock is derived from `lastEmailSentAt` so it survives a
   *  page refresh rather than resetting with a component-local counter. */
  emailSentAt: z.string().nullable(),
  lastEmailSentAt: z.string().nullable(),
  resendCount: z.number().int().nonnegative(),
  lines: z.array(batchLineDtoSchema),
  /** Per-gas, per-location counts. Empty only for a batch with no cylinders. */
  distribution: z.array(batchDistributionEntrySchema),
});

export const batchDtoSchema = batchCoreSchema.extend({
  cylinders: z.array(cylinderDtoSchema),
});
export type BatchDto = z.infer<typeof batchDtoSchema>;

export const batchSummarySchema = batchCoreSchema.extend({
  cylinderCount: z.number().int().nonnegative(),
  returnedCount: z.number().int().nonnegative(),
});
export type BatchSummary = z.infer<typeof batchSummarySchema>;

/**
 * Which tab is asking. The Transfer, Returns, Initialize and History lists are one
 * component and one query; the scope is the only thing that differs between them,
 * passed in rather than branched on inside.
 *
 * Since partial movement became first-class, scope no longer hides rows by *movement*
 * history — a batch that has moved can always move again. It does hide by
 * INITIALIZATION, which is a different kind of fact: an uninitialized batch has no
 * labels on it yet, so `transfer` and `returns` drop it because the action they offer
 * cannot legally succeed, and `initialize` shows only those batches, because they are
 * the entire point of that screen.
 */
export const batchListScopeSchema = z.enum(['transfer', 'returns', 'initialize', 'history']);
export type BatchListScope = z.infer<typeof batchListScopeSchema>;

/**
 * Query string for `GET /batches`. Validated rather than read raw: an unrecognised
 * `status` used to fall through to the `active` branch, so `?status=RETRUNED` quietly
 * returned the opposite of what was asked for.
 */
export const batchListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  status: z.enum(['active', 'all']).default('active'),
  /** Live search — matches project number OR project manager name, substring, ci. */
  q: z.string().max(200).optional(),
  projectManagerId: z.string().min(1).optional(),
  supplierId: z.string().min(1).optional(),
  gasTypeId: z.string().min(1).optional(),
  scope: batchListScopeSchema.default('history'),
});
export type BatchListQuery = z.infer<typeof batchListQuerySchema>;

export const createBatchResponseSchema = z.object({
  batch: batchDtoSchema,
  serials: z.array(z.string()),
});
export type CreateBatchResponse = z.infer<typeof createBatchResponseSchema>;

export const batchListResponseSchema = z.object({
  batches: z.array(batchSummarySchema),
  /** Rows matching the filters, and rows in scope before any filter — `12 of 48`. */
  matched: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type BatchListResponse = z.infer<typeof batchListResponseSchema>;

export const batchDetailResponseSchema = z.object({ batch: batchDtoSchema });
export type BatchDetailResponse = z.infer<typeof batchDetailResponseSchema>;

/** How long the resend control stays locked after a send. Server-enforced. */
export const RESEND_LOCKOUT_SECONDS = 60;

export const resendBatchEmailResponseSchema = z.object({
  batchId: z.string(),
  emailSentAt: z.string().nullable(),
  lastEmailSentAt: z.string().nullable(),
  resendCount: z.number().int().nonnegative(),
  /** 0 once the control is free again; >0 while the lock is still running down. */
  retryAfterSeconds: z.number().int().nonnegative(),
});
export type ResendBatchEmailResponse = z.infer<typeof resendBatchEmailResponseSchema>;

// ----------------------------- derived helpers -----------------------------

/** Total cylinders a draft or a batch holds. One definition, used by both. */
export const totalQuantity = (lines: { quantity: number }[]): number =>
  lines.reduce((n, l) => n + l.quantity, 0);

/**
 * "7 × Nitrogen, 4 × Argon" — the one-line contents summary shown wherever a batch
 * appears as a row. Long batches are truncated rather than wrapped to four lines.
 */
export function summariseLines(lines: { quantity: number; gasTypeName: string }[]): string {
  if (lines.length === 0) return 'No cylinders';
  const shown = lines.slice(0, 3).map((l) => `${l.quantity} × ${l.gasTypeName}`);
  const rest = lines.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

/**
 * "3 at Stores · 4 at Yard B" for one gas — the partial-movement fact, rendered.
 * Returned cylinders are listed last because they are terminal: what is still out is
 * what the reader is deciding about.
 */
export function summariseDistribution(entries: BatchDistributionEntry[]): string {
  const order: Record<BatchLocationKind, number> = { STORES: 0, SITE: 1, RETURNED: 2 };
  return [...entries]
    .sort((a, b) => order[a.kind] - order[b.kind] || a.locationName.localeCompare(b.locationName))
    .map((e) => `${e.count} ${e.kind === 'RETURNED' ? 'returned' : `at ${e.locationName}`}`)
    .join(' · ');
}
