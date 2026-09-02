import { z } from 'zod';
import {
  hasPhotoEvidence,
  photoSubmissionFields,
  PHOTO_REQUIRED_MESSAGE,
  batchPhotoDtoSchema,
} from './photo';
import { overrideSerialsSchema, scanInputSchema, scanRejectionSchema } from './transfer';

/**
 * Workflow A2 — batch initialization, the first scan.
 *
 * Creating a batch allocates serials and emails a QR sheet; it does not put a label
 * on a cylinder. Somebody prints that sheet, walks to the batch, and sticks each
 * label on. Initialization is the scan that proves they did — every cylinder read
 * back off its own physical sticker, in the place the batch was created, with a photo
 * of the assembled batch.
 *
 * ## Why it must cover the WHOLE batch
 *
 * Unlike a transfer, which legitimately moves 3 of 7 cylinders, initialization is a
 * statement about the batch as a unit: "every label is on, and here is the batch".
 * A partial initialization would leave the system unable to say whether cylinder 4 is
 * unlabelled or merely unscanned — which is the exact ambiguity this step exists to
 * remove. So the request must name every cylinder in the batch, and the server
 * refuses it otherwise (`INCOMPLETE_INITIALIZATION`, listing what is missing).
 *
 * ## Why it gates everything downstream
 *
 * A cylinder with no label on it cannot be scanned onto a truck, so a transfer or
 * return of an uninitialized batch could only ever have been an override. Refusing it
 * outright says so honestly instead of letting the batch drift through its whole
 * lifecycle on assertions.
 */
export const createInitializationRequestSchema = z
  .object({
    batchId: z.string().min(1),
    /** Minted once when the initialization is enqueued — never per retry. */
    clientRequestId: z.string().min(8).max(64),
    /** Camera-verified scans. May be empty only when `overrideSerials` is not. */
    scans: z.array(scanInputSchema).max(500).default([]),
    /** ADMIN only — 403 for every other role, exactly as on transfers. */
    overrideSerials: overrideSerialsSchema.default([]),
    ...photoSubmissionFields,
  })
  .refine((i) => i.scans.length + i.overrideSerials.length > 0, {
    message: 'Nothing to initialize: scan at least one cylinder.',
    path: ['scans'],
  })
  .refine(hasPhotoEvidence, { message: PHOTO_REQUIRED_MESSAGE, path: ['photo'] });
export type CreateInitializationRequest = z.infer<typeof createInitializationRequestSchema>;

export const initializationDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  userId: z.string(),
  createdAt: z.string(),
  /** Every serial in the batch, since a partial initialization is refused. */
  initializedSerials: z.array(z.string()),
  /** The subset an admin waved through without a scan. */
  overriddenSerials: z.array(z.string()),
  /** Null only when an admin overrode the camera. */
  photo: batchPhotoDtoSchema.nullable(),
  photoOverridden: z.boolean(),
});
export type InitializationDto = z.infer<typeof initializationDtoSchema>;

export const createInitializationResponseSchema = z.object({
  initialization: initializationDtoSchema,
  rejected: z.array(scanRejectionSchema),
});
export type CreateInitializationResponse = z.infer<typeof createInitializationResponseSchema>;
