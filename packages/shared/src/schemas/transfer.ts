import { z } from 'zod';
import { SERIAL_CODE_RE } from '../serial';
import {
  batchPhotoDtoSchema,
  hasPhotoEvidence,
  photoSubmissionFields,
  PHOTO_REQUIRED_MESSAGE,
} from './photo';

export const destinationTypeSchema = z.enum(['SITE', 'STORES']);
export type DestinationType = z.infer<typeof destinationTypeSchema>;

/**
 * INTAKE is booking the batch in; INITIALIZE is the first physical scan that proves
 * the printed labels are actually on those cylinders. They are separate types because
 * they are separate claims — one is paperwork, the other is evidence — and collapsing
 * them would make an uninitialized batch indistinguishable from an initialized one.
 */
export const movementTypeSchema = z.enum(['INTAKE', 'INITIALIZE', 'TRANSFER', 'RETURN']);
export type MovementType = z.infer<typeof movementTypeSchema>;

/**
 * One physical scan (Workflow B3 — CRITICAL ENFORCEMENT: the serial must come from
 * the camera, never typed). `qrPayload` is the raw signed payload the scanner read;
 * the server re-verifies its signature so a device that skipped its own offline
 * check cannot submit a serial it never actually saw.
 */
export const scanInputSchema = z.object({
  serialCode: z.string().regex(SERIAL_CODE_RE, 'Not a cylinder serial code'),
  qrPayload: z.string().min(1).max(300),
  /** Device clock at scan time — the audit trail's `deviceAt`. */
  scannedAt: z.string().datetime(),
});
export type ScanInput = z.infer<typeof scanInputSchema>;

/** Destination picker (Workflow B4): another site, or back to stores. */
export const transferDestinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SITE'), siteId: z.string().min(1) }),
  z.object({ type: z.literal('STORES') }),
]);
export type TransferDestination = z.infer<typeof transferDestinationSchema>;

/**
 * Serials an ADMIN moved WITHOUT a physical scan.
 *
 * Kept as its own field rather than a nullable `qrPayload` on `scanInputSchema`, so
 * "a scan is always a camera-verified signed payload" stays true with no exceptions
 * to reason about. An override is a different kind of evidence — a named admin's
 * assertion instead of a label — and the server records it as such
 * (`MovementEvent.overridden`), so the audit trail never claims a cylinder was seen
 * when it was not.
 */
export const overrideSerialsSchema = z
  .array(z.string().regex(SERIAL_CODE_RE, 'Not a cylinder serial code'))
  .max(500);

export const createTransferRequestSchema = z
  .object({
    batchId: z.string().min(1),
    /** Minted once when the transfer is enqueued — never per retry. */
    clientRequestId: z.string().min(8).max(64),
    destination: transferDestinationSchema,
    /** Camera-verified scans. May be empty only when `overrideSerials` is not. */
    scans: z.array(scanInputSchema).max(500).default([]),
    /** ADMIN only — 403 for every other role. */
    overrideSerials: overrideSerialsSchema.default([]),
    /**
     * Reassign the batch to a different project manager as part of this move.
     * Omitted leaves it unchanged. A batch that outlives the manager who booked it in
     * — or whose manager has since been deactivated — needs somewhere to hand the
     * paperwork over, and the moment it changes hands is the moment it moves.
     */
    projectManagerId: z.string().min(1).optional(),
    /**
     * The batch photo, taken between the scan step and the destination step. Required
     * for the same reason the scan is: the serials say which cylinders, the photo says
     * they were together, here, now. See `schemas/photo.ts`.
     */
    ...photoSubmissionFields,
  })
  .refine((t) => t.scans.length + t.overrideSerials.length > 0, {
    message: 'Nothing to transfer: scan at least one cylinder.',
    path: ['scans'],
  })
  .refine(hasPhotoEvidence, { message: PHOTO_REQUIRED_MESSAGE, path: ['photo'] });
export type CreateTransferRequest = z.infer<typeof createTransferRequestSchema>;

/** Why one scanned serial could not be moved. The app highlights that row rather
 *  than failing the whole submission opaquely. */
export const scanRejectionCodeSchema = z.enum([
  'UNKNOWN_SERIAL', // no cylinder with this serial
  'WRONG_BATCH', // exists, but belongs to a different batch
  'ALREADY_RETURNED', // terminal state — cannot move
  'DUPLICATE_SCAN', // the same serial appeared twice in one submission
  'ALREADY_AT_DESTINATION', // no-op move
  'BAD_QR_SIGNATURE', // payload failed signature verification
  'SERIAL_MISMATCH', // payload's serial != the reported serialCode
  'CONFLICT', // lost a race with a concurrent transfer/return
  'NOT_INITIALIZED', // the batch was never scanned in, so nothing in it can move yet
]);
export type ScanRejectionCode = z.infer<typeof scanRejectionCodeSchema>;

export const scanRejectionSchema = z.object({
  serialCode: z.string(),
  code: scanRejectionCodeSchema,
  message: z.string(),
});
export type ScanRejection = z.infer<typeof scanRejectionSchema>;

export const transferDtoSchema = z.object({
  id: z.string(),
  batchId: z.string(),
  destinationType: destinationTypeSchema,
  destinationSiteId: z.string().nullable(),
  destinationSiteName: z.string().nullable(),
  userId: z.string(),
  createdAt: z.string(),
  /** Serials that actually moved. */
  movedSerials: z.array(z.string()),
  /** The subset of `movedSerials` an admin waved through unscanned. */
  overriddenSerials: z.array(z.string()),
  /** Set when this transfer also handed the batch to a different manager. */
  projectManagerId: z.string().nullable(),
  projectManagerName: z.string().nullable(),
  /** Null only when an admin overrode the camera. */
  photo: batchPhotoDtoSchema.nullable(),
  photoOverridden: z.boolean(),
});
export type TransferDto = z.infer<typeof transferDtoSchema>;

export const createTransferResponseSchema = z.object({
  transfer: transferDtoSchema,
  /** Empty on a fully successful submission. */
  rejected: z.array(scanRejectionSchema),
});
export type CreateTransferResponse = z.infer<typeof createTransferResponseSchema>;

/** 422 body when every scan was rejected — no Transfer row is created. */
export const transferRejectedResponseSchema = z.object({
  error: z.object({
    code: z.literal('NO_VALID_SCANS'),
    message: z.string(),
    details: z.object({ rejected: z.array(scanRejectionSchema) }),
  }),
});
export type TransferRejectedResponse = z.infer<typeof transferRejectedResponseSchema>;
