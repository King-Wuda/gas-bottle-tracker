import { z } from 'zod';
import { batchStatusSchema } from './batch';
import {
  batchPhotoDtoSchema,
  capturedPhotoSchema,
  hasPhotoEvidence,
  photoSubmissionFields,
  PHOTO_MAX_BASE64,
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

/**
 * The number off the document the driver presented.
 *
 * Deliberately NOT validated as a South African ID number. The system has to be able
 * to record a passport, a foreign licence, or an asylum permit — a driver who cannot
 * be recorded is a driver who leaves with the cylinders and no name against them,
 * which is worse than a number in an unexpected format. The bounds are here only to
 * stop an empty field and an unbounded body.
 */
export const driverIdNumberSchema = z
  .string()
  .trim()
  .min(4, 'Enter the number from the driver’s ID')
  .max(40, 'That does not look like an ID number');

export const DRIVER_ID_PHOTO_REQUIRED_MESSAGE =
  'A photo of the driver’s ID is required. Take one, or ask an admin to override the camera.';

/**
 * The identity half of a return: who took the cylinders, proved the same way the
 * batch itself is proved.
 *
 * A name and a signature say who SAYS they took them. The number and the photographed
 * document are what make that checkable afterwards — the delivery note stops being a
 * squiggle over a name somebody typed. The override exists for the same reason the
 * batch photo's does (see `schemas/photo.ts`): the camera can be the thing that has
 * failed, and it is recorded as an admin's waiver rather than dressed up as a
 * document that was never seen.
 */
export const driverIdFields = {
  driverIdNumber: driverIdNumberSchema,
  driverIdPhoto: capturedPhotoSchema.nullable().default(null),
  /** ADMIN only — 403 for every other role, exactly like `photoOverride`. */
  driverIdOverride: z.boolean().default(false),
} as const;

export const hasDriverIdEvidence = (v: {
  driverIdPhoto: unknown | null;
  driverIdOverride: boolean;
}): boolean => v.driverIdPhoto !== null || v.driverIdOverride;

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
  driverName: z.string(),
  /** Null on returns recorded before ID capture existed — see the Prisma model. */
  driverIdNumber: z.string().nullable(),
  /** True when an admin waived the ID photo. `driverIdCaptured` is then false. */
  driverIdOverridden: z.boolean(),
  /** Whether an ID document image is actually on file for this return. */
  driverIdCaptured: z.boolean(),
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
