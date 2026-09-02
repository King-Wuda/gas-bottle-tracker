import { z } from 'zod';
import { batchStatusSchema } from './batch';
import {
  batchPhotoDtoSchema,
  hasPhotoEvidence,
  photoSubmissionFields,
  PHOTO_REQUIRED_MESSAGE,
} from './photo';
import { overrideSerialsSchema, scanInputSchema, scanRejectionSchema } from './transfer';

/**
 * Workflow C — the Stores Manager scans cylinders coming back, the collection driver
 * signs on screen, and the PM is emailed a delivery note.
 */

/** ~2 MB of base64 ≈ a 1.5 MB PNG — far above any signature canvas, but bounded so a
 *  malformed client cannot post an unbounded body. Accepts a bare base64 string or a
 *  `data:image/png;base64,…` URL, which is what a signature canvas hands back. */
export const signaturePngSchema = z
  .string()
  .min(64, 'Signature is empty')
  .max(2_800_000, 'Signature image is too large');

export const createReturnRequestSchema = z
  .object({
    batchId: z.string().min(1),
    /** Minted once when the return is enqueued — never per retry. */
    clientRequestId: z.string().min(8).max(64),
    /** Same mandatory-scan rule as transfers: nothing is returned unscanned. */
    scans: z.array(scanInputSchema).max(500).default([]),
    /** ADMIN only, and recorded as unscanned evidence — see the transfer schema. */
    overrideSerials: overrideSerialsSchema.default([]),
    driverName: z.string().min(1).max(200),
    signaturePng: signaturePngSchema,
    /** The batch photo, taken between the scan step and the signature. */
    ...photoSubmissionFields,
  })
  .refine((r) => r.scans.length + r.overrideSerials.length > 0, {
    message: 'Nothing to return: scan at least one cylinder.',
    path: ['scans'],
  })
  .refine(hasPhotoEvidence, { message: PHOTO_REQUIRED_MESSAGE, path: ['photo'] });
export type CreateReturnRequest = z.infer<typeof createReturnRequestSchema>;

export const returnRecordDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  driverName: z.string(),
  storesManagerId: z.string(),
  createdAt: z.string(),
  /** Serials actually returned by this submission. */
  returnedSerials: z.array(z.string()),
  /** The subset of `returnedSerials` an admin waved through unscanned. */
  overriddenSerials: z.array(z.string()),
  /** The batch's status AFTER this return — PARTIAL until the last cylinder is back. */
  batchStatus: batchStatusSchema,
  /** How much of the batch is still out, for the confirmation screen. */
  outstandingCount: z.number().int().nonnegative(),
  /** Null only when an admin overrode the camera. */
  photo: batchPhotoDtoSchema.nullable(),
  photoOverridden: z.boolean(),
});
export type ReturnRecordDto = z.infer<typeof returnRecordDtoSchema>;

export const createReturnResponseSchema = z.object({
  returnRecord: returnRecordDtoSchema,
  rejected: z.array(scanRejectionSchema),
});
export type CreateReturnResponse = z.infer<typeof createReturnResponseSchema>;
