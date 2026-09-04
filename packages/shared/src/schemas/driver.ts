import { z } from 'zod';
import { capturedPhotoSchema } from './photo';

/**
 * Who took the cylinders, and how that is proved.
 *
 * Shared by Workflow B (transfer) and Workflow C (return), because both hand physical
 * cylinders to a named person who is not the operator, and both need the same answer
 * to "who signed for these?" months later. It lives in its own module rather than in
 * either flow's file so neither owns it — a transfer importing its driver rules from
 * `return.ts` would read as an accident, and would become one the first time the two
 * needed to differ.
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

/** The DTO fields both a transfer and a return expose about the driver. Every one is
 *  nullable or false for records made before sign-off was collected on that flow. */
export const driverSignOffDtoFields = {
  /** Null on records that predate driver sign-off on this flow. */
  driverName: z.string().nullable(),
  driverIdNumber: z.string().nullable(),
  /** True when an admin waived the ID photo. `driverIdCaptured` is then false. */
  driverIdOverridden: z.boolean(),
  /** Whether an ID document image is actually on file. */
  driverIdCaptured: z.boolean(),
} as const;
