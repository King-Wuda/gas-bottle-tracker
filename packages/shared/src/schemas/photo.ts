import { z } from 'zod';

/**
 * The batch photo taken at the end of every scan session — initialization, transfer
 * and return alike.
 *
 * ## Why a photo at all
 *
 * A scan proves a *label* was in front of a camera. It does not prove the cylinders
 * were together, at the place the paperwork names, on the day it names. The photo is
 * the evidence for the claim the serials cannot make on their own, which is why it is
 * stamped with position and both clocks rather than being a bare image.
 *
 * ## The two clocks, and why both are kept
 *
 * `capturedAt` is the device's clock at the shutter. A field phone's clock can be
 * minutes to days out, and the photo may be captured in a dead spot and uploaded a
 * day later, so it is recorded as what it is — the device's claim — and the server
 * stamps its own `serverAt` on arrival. Neither is dropped in favour of the other:
 * the gap between them is itself the fact that tells you a submission was queued.
 *
 * ## Location is best-effort, on purpose
 *
 * A fix can fail for reasons that have nothing to do with honesty: indoors, in a
 * steel yard, location switched off at the OS level. Refusing to accept the photo
 * then would strand a driver at the gate with cylinders on a truck, so the position
 * is nullable and `locationError` records *why* it is missing. A missing fix is
 * visibly missing; it is never silently rendered as 0°N 0°E.
 */

/** Bare base64 or a `data:image/jpeg;base64,…` URL, which is what the camera hands
 *  back. The device downscales before encoding — see `compressForUpload` — so this
 *  ceiling is a backstop against a malformed client, not the expected size. */
export const PHOTO_MAX_BASE64 = 4_000_000;

export const capturedPhotoSchema = z.object({
  imageBase64: z
    .string()
    .min(64, 'Photo is empty')
    .max(PHOTO_MAX_BASE64, 'Photo is too large — retake it'),
  /** Device clock at the shutter. */
  capturedAt: z.string().datetime(),
  /** Null together when no fix was obtained; `locationError` then says why. */
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  /** Radius of the fix in metres, as reported by the OS. */
  accuracyM: z.number().nonnegative().nullable(),
  /** Human-readable reason there is no position, e.g. "Location permission denied". */
  locationError: z.string().max(200).nullable(),
});
export type CapturedPhoto = z.infer<typeof capturedPhotoSchema>;

/**
 * The stored photo, as history renders it. Deliberately carries no image bytes: a
 * feed of 100 events would be a hundred megabytes. `GET /batch-photos/:id` returns
 * the image itself, one at a time, when someone actually opens the event.
 */
export const batchPhotoDtoSchema = z.object({
  id: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  accuracyM: z.number().nullable(),
  locationError: z.string().nullable(),
  /** Device clock at the shutter, and the server's clock on arrival. */
  capturedAt: z.string(),
  serverAt: z.string(),
  userId: z.string(),
  userName: z.string(),
});
export type BatchPhotoDto = z.infer<typeof batchPhotoDtoSchema>;

/** The image itself, fetched on demand for one event's detail screen. */
export const batchPhotoImageResponseSchema = z.object({
  photo: batchPhotoDtoSchema,
  mimeType: z.string(),
  /** Bare base64 — the client builds its own `data:` URL. */
  imageBase64: z.string(),
});
export type BatchPhotoImageResponse = z.infer<typeof batchPhotoImageResponseSchema>;

/**
 * The photo half of every scan submission.
 *
 * `photoOverride` is the same idea as `overrideSerials`, applied to the camera: an
 * ADMIN can submit without a photo when the camera is the thing that has failed, and
 * the record says an admin waved it through rather than showing a submission that
 * looks like it was photographed. Every other role is refused (403), never silently
 * accepted — an override that looked like a photo would quietly devalue every real
 * photo in the system.
 */
export const photoSubmissionFields = {
  photo: capturedPhotoSchema.nullable().default(null),
  /** ADMIN only — 403 for every other role. */
  photoOverride: z.boolean().default(false),
} as const;

/**
 * Shared refinement: a submission carries a photo, or an admin's waiver, or it is
 * refused. Both at once is allowed and the photo wins — the same rule scans follow,
 * where a serial that was genuinely scanned keeps the scan even if it was also listed
 * as an override. Real evidence outranks an assertion; it is never downgraded to one.
 */
export const hasPhotoEvidence = (v: { photo: unknown | null; photoOverride: boolean }): boolean =>
  v.photo !== null || v.photoOverride;

export const PHOTO_REQUIRED_MESSAGE =
  'A photo of the batch is required. Take one, or ask an admin to override the camera.';
