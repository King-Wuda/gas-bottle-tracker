import { z } from 'zod';
import { batchStatusSchema } from './batch';
import {
  batchPhotoDtoSchema,
  hasPhotoEvidence,
  photoSubmissionFields,
  PHOTO_MAX_BASE64,
  PHOTO_REQUIRED_MESSAGE,
} from './photo';
import {
  driverIdFields,
  driverSignOffDtoFields,
  hasDriverIdEvidence,
  signaturePngSchema,
  DRIVER_ID_PHOTO_REQUIRED_MESSAGE,
} from './driver';
import { overrideSerialsSchema, scanInputSchema, scanRejectionSchema } from './transfer';

/**
 * Workflow C — the Stores Manager scans cylinders coming back, the collection driver
 * signs on screen, and the PM is emailed a delivery note.
 */

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
    ...driverIdFields,
    signaturePng: signaturePngSchema,
    /** The batch photo, taken between the scan step and the signature. */
    ...photoSubmissionFields,
  })
  .refine((r) => r.scans.length + r.overrideSerials.length > 0, {
    message: 'Nothing to return: scan at least one cylinder.',
    path: ['scans'],
  })
  .refine(hasPhotoEvidence, { message: PHOTO_REQUIRED_MESSAGE, path: ['photo'] })
  .refine(hasDriverIdEvidence, {
    message: DRIVER_ID_PHOTO_REQUIRED_MESSAGE,
    path: ['driverIdPhoto'],
  });
export type CreateReturnRequest = z.infer<typeof createReturnRequestSchema>;

export const returnRecordDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  ...driverSignOffDtoFields,
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

/**
 * Reading the driver's ID number off the photographed document (or a barcode).
 *
 * A convenience, never a requirement: the number is typed by hand offline exactly as
 * before, and this only ever produces a SUGGESTION the operator accepts or ignores.
 * That is why the response has room for a reason as well as a result — "we could not
 * read it" is a useful answer, and the flow continues either way.
 */
export const readDriverIdRequestSchema = z.object({
  /** Bare base64 or a data URL, the same shapes a captured photo arrives in. */
  imageBase64: z.string().min(64, 'Photo is empty').max(PHOTO_MAX_BASE64, 'Photo is too large'),
});
export type ReadDriverIdRequest = z.infer<typeof readDriverIdRequestSchema>;

export const readDriverIdResponseSchema = z.object({
  /** The number, when exactly one checksum-valid candidate was found. */
  idNumber: z.string().nullable(),
  /** "8001015009087 - born 1980-01-01 - male", for the operator to check against the
   *  card in their hand before accepting it. */
  description: z.string().nullable(),
  /** Why there is no number, when there is none. Shown as-is. */
  reason: z.string().nullable(),
});
export type ReadDriverIdResponse = z.infer<typeof readDriverIdResponseSchema>;
