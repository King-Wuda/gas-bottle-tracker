import { decodePhoto, InvalidPhotoError, saveDriverIdPhoto } from './photo.js';
import { decodeSignaturePng, InvalidSignatureError, saveSignature } from './signature.js';

/**
 * The identity half of a movement: who took the cylinders, and the evidence for it.
 *
 * Shared by transfers and returns because both hand physical cylinders to a named
 * person who is not the operator. Recording it on one and not the other left the more
 * common movement as the less accountable one.
 *
 * Everything here is filesystem (or database) IO, so it is called BEFORE the
 * transaction: holding a row lock across a blob write would widen the contended
 * window for no reason. Filenames derive from the idempotency key, so a retry
 * overwrites its own files rather than accumulating one set per attempt.
 */
export type PreparedDriverSignOff =
  | {
      ok: true;
      signaturePath: string;
      /** Null when an admin waived the ID photo. */
      driverIdPath: string | null;
      driverIdOverridden: boolean;
    }
  | { ok: false; status: number; code: string; message: string };

export async function prepareDriverSignOff(args: {
  clientRequestId: string;
  signaturePng: string;
  driverIdPhoto: { imageBase64: string } | null;
  driverIdOverride: boolean;
  role: string;
  /** "moved" or "returned" — used only in the 403's wording. */
  verb: string;
}): Promise<PreparedDriverSignOff> {
  // The ID camera override is the same kind of claim as the scan and batch-photo
  // overrides: an admin's word in place of evidence. Refused outright for every other
  // role rather than quietly ignored — an override that was silently dropped would
  // let a tampered client believe it recorded a document nobody saw.
  if (args.driverIdOverride && !args.driverIdPhoto && args.role !== 'ADMIN') {
    return {
      ok: false,
      status: 403,
      code: 'DRIVER_ID_OVERRIDE_FORBIDDEN',
      message: `Only an admin can record a batch ${args.verb} without photographing the driver’s ID.`,
    };
  }

  let signaturePath: string;
  try {
    signaturePath = await saveSignature(
      args.clientRequestId,
      decodeSignaturePng(args.signaturePng),
    );
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      return { ok: false, status: 400, code: 'INVALID_SIGNATURE', message: err.message };
    }
    throw err;
  }

  // Real evidence outranks an assertion: a submission carrying both a photo and an
  // override keeps the photo — the same rule scans and batch photos already follow.
  let driverIdPath: string | null = null;
  if (args.driverIdPhoto) {
    try {
      driverIdPath = await saveDriverIdPhoto(
        args.clientRequestId,
        decodePhoto(args.driverIdPhoto.imageBase64),
      );
    } catch (err) {
      if (err instanceof InvalidPhotoError) {
        return { ok: false, status: 400, code: 'INVALID_DRIVER_ID_PHOTO', message: err.message };
      }
      throw err;
    }
  }

  return { ok: true, signaturePath, driverIdPath, driverIdOverridden: driverIdPath === null };
}
