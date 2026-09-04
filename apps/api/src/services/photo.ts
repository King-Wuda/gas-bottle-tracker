/**
 * Batch photo handling — the evidence half of every scan session.
 *
 * Shaped on `services/signature.ts`, and for the same reason: the bytes are verified
 * to actually be an image before anything is stored. A history screen that renders
 * "[photo unavailable]" because someone posted a JSON blob would be worthless exactly
 * when it is being relied on.
 */
import { PHOTO_REQUIRED_MESSAGE, type CapturedPhoto } from '@gct/shared';
import { saveFile } from './storage.js';

export class InvalidPhotoError extends Error {}

/** Magic bytes, so the mime type is derived from the file rather than trusted. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface DecodedPhoto {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
  extension: 'jpg' | 'png';
}

/**
 * Accepts a bare base64 string or a `data:image/…;base64,…` URL — the camera hands
 * back the latter. The declared mime type in the data URL is IGNORED in favour of the
 * decoded bytes: it is client-supplied text, and the whole point of the check is to
 * establish what the file really is.
 */
export function decodePhoto(input: string): DecodedPhoto {
  const base64 = input.startsWith('data:') ? (input.split(',', 2)[1] ?? '') : input;
  if (!base64) throw new InvalidPhotoError('Photo data URL has no payload');

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new InvalidPhotoError('Photo is not valid base64');
  }

  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return { bytes, mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { bytes, mimeType: 'image/png', extension: 'png' };
  }
  throw new InvalidPhotoError('Photo must be a JPEG or PNG image');
}

/**
 * Written under a name derived from the idempotency key, so a retry overwrites its
 * own file rather than accumulating one per attempt — the same rule signatures follow.
 */
export function savePhoto(clientRequestId: string, photo: DecodedPhoto): Promise<string> {
  return saveFile('photos', `batch-${clientRequestId}.${photo.extension}`, photo.bytes);
}

/**
 * The driver's ID document, stored beside the batch photos.
 *
 * A separate name rather than a separate `StorageKind`: it is the same sort of file
 * in the same place, and the prefix is what distinguishes it. Like every other blob
 * here the filename is derived from the idempotency key, so a retry overwrites its
 * own file instead of littering one per attempt.
 */
export function saveDriverIdPhoto(clientRequestId: string, photo: DecodedPhoto): Promise<string> {
  return saveFile('photos', `driver-id-${clientRequestId}.${photo.extension}`, photo.bytes);
}

/**
 * The columns a `BatchPhoto` row is built from, minus the owner link.
 *
 * `capturedAt` is parsed from the device's own clock and stored as given. It is not
 * clamped to the server's time even when it is implausible: the record's job is to say
 * what the device claimed, and `serverAt` (a database default) is there to be compared
 * against it. Silently correcting one would destroy the only signal that a submission
 * sat in an outbox overnight.
 */
export function photoColumns(
  photo: CapturedPhoto,
  decoded: DecodedPhoto,
  path: string,
  userId: string,
  batchId: string,
) {
  return {
    batchId,
    userId,
    path,
    mimeType: decoded.mimeType,
    latitude: photo.latitude,
    longitude: photo.longitude,
    accuracyM: photo.accuracyM,
    locationError: photo.locationError,
    capturedAt: new Date(photo.capturedAt),
  };
}

/**
 * The whole photo half of a submission, resolved once for all three routes.
 *
 * Called BEFORE the transaction on purpose. Decoding and writing a file is filesystem
 * IO, and holding a row lock across it would widen the contended window for no reason
 * — the same ordering `returns.ts` already uses for the driver's signature.
 */
export type PreparedPhoto =
  | { ok: true; overridden: true; columns: null }
  | { ok: true; overridden: false; columns: ReturnType<typeof photoColumns> }
  | { ok: false; status: number; code: string; message: string };

export async function preparePhoto(args: {
  photo: CapturedPhoto | null;
  photoOverride: boolean;
  role: string;
  userId: string;
  batchId: string;
  clientRequestId: string;
  /** "moved", "returned", "initialized" — used only in the 403's wording. */
  verb: string;
}): Promise<PreparedPhoto> {
  // Real evidence outranks an assertion: a submission carrying both a photo and an
  // override keeps the photo, exactly as a serial that was genuinely scanned keeps
  // its scan even when it also appears in overrideSerials.
  if (args.photo) {
    let decoded: DecodedPhoto;
    try {
      decoded = decodePhoto(args.photo.imageBase64);
    } catch (err) {
      if (err instanceof InvalidPhotoError) {
        return { ok: false, status: 400, code: 'INVALID_PHOTO', message: err.message };
      }
      throw err;
    }
    const path = await savePhoto(args.clientRequestId, decoded);
    return {
      ok: true,
      overridden: false,
      columns: photoColumns(args.photo, decoded, path, args.userId, args.batchId),
    };
  }

  // No photo and no claim to be allowed to skip one. The request schema's refinement
  // already rejects this shape; repeated here because this function is the thing that
  // decides, and it should not depend on every future caller having parsed strictly.
  if (!args.photoOverride) {
    return { ok: false, status: 400, code: 'PHOTO_REQUIRED', message: PHOTO_REQUIRED_MESSAGE };
  }

  // The only way through is an admin's override, and a non-admin who sends one is
  // refused outright rather than having it quietly ignored — silently dropping it
  // would let a tampered client believe it recorded work that was never evidenced.
  if (args.role !== 'ADMIN') {
    return {
      ok: false,
      status: 403,
      code: 'PHOTO_OVERRIDE_FORBIDDEN',
      message: `Only an admin can record a batch ${args.verb} without a photo.`,
    };
  }
  return { ok: true, overridden: true, columns: null };
}
