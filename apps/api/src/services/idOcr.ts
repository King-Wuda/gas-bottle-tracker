import { createWorker, type Worker } from 'tesseract.js';
import { findSouthAfricanIds, parseSouthAfricanId, type SouthAfricanId } from '@gct/shared';
import { decodePhoto, InvalidPhotoError } from './photo.js';

/**
 * Reading the driver's ID number off the photograph of their document.
 *
 * ## Why this is a server job
 *
 * The obvious place for it is the phone — the photo is already there and the operator
 * is standing in front of the driver. But there is no OCR that runs on both of this
 * app's targets: a native OCR module does nothing in the browser the app is tested in,
 * and the WebAssembly engines do not run under Hermes. Rather than ship two
 * implementations and test one of them, the image is sent to the API, which already
 * receives it a moment later anyway.
 *
 * The cost is that autofill needs a connection. That is acceptable precisely because
 * it is only autofill: the number is typed by hand offline, exactly as before, and
 * the return still submits from a dead spot. Nothing about the record depends on this
 * succeeding.
 *
 * ## Why it would rather say nothing than guess
 *
 * A misread of a thirteen-digit number is another thirteen-digit number, and it looks
 * exactly as convincing as the truth. Two rules keep that out of the record:
 *
 * - Only a number whose Luhn checksum is valid is ever returned. That rejects every
 *   single-digit misread — which is what OCR errors overwhelmingly are.
 * - Only an UNAMBIGUOUS result is returned. If the page yields two checksum-valid
 *   candidates, this hands back nothing, because there is no principled way to choose
 *   and the operator has the card in their hand.
 *
 * And the client never applies the result silently; it offers it. See
 * `app/returns/sign.tsx`.
 */

/** OCR is a fixed cost per image and the worker is expensive to start, so one is kept
 *  for the life of the process and requests queue on it. */
let workerPromise: Promise<Worker> | null = null;

function worker(): Promise<Worker> {
  workerPromise ??= (async () => {
    const w = await createWorker('eng');
    // Digits and separators only. An ID number contains nothing else, and narrowing
    // the alphabet is the single biggest accuracy win available here — it stops the
    // engine from reading a 0 as an O or a 1 as an I and then failing the checksum.
    await w.setParameters({ tessedit_char_whitelist: '0123456789 -' });
    return w;
  })();
  return workerPromise;
}

/** Frees the worker; called from the server's shutdown path. */
export async function stopIdOcr(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  if (pending) await (await pending).terminate().catch(() => {});
}

export type IdOcrResult =
  | { ok: true; id: SouthAfricanId }
  /** Read the image fine, found nothing usable. `reason` is shown to the operator. */
  | { ok: false; reason: string };

/**
 * A single image in, at most one ID number out.
 *
 * Never throws for a bad photo — an unreadable image is an answer ("we could not read
 * it"), not an error, because the operator's next move is the same either way: type
 * the number.
 */
export async function readIdNumber(imageBase64: string): Promise<IdOcrResult> {
  let bytes: Buffer;
  try {
    bytes = decodePhoto(imageBase64).bytes;
  } catch (err) {
    if (err instanceof InvalidPhotoError) return { ok: false, reason: err.message };
    throw err;
  }

  // The engine can still refuse an image the magic-byte check accepted — a truncated
  // file, an unsupported bit depth. That is the same kind of answer as "nothing
  // legible on it", so it is reported rather than thrown: this endpoint must never be
  // the reason a driver cannot be signed off.
  let text: string;
  try {
    text = (await (await worker()).recognize(bytes)).data.text;
  } catch {
    return { ok: false, reason: 'That photo could not be read. Type the number instead.' };
  }
  const candidates = findSouthAfricanIds(text);

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'No South African ID number could be read from that photo. Type it instead.',
    };
  }
  if (candidates.length > 1) {
    // Ambiguity is reported rather than resolved. Picking the first would be a coin
    // toss dressed up as a reading.
    return {
      ok: false,
      reason: 'More than one possible ID number was read from that photo. Type it instead.',
    };
  }

  const id = parseSouthAfricanId(candidates[0]!);
  return id ? { ok: true, id } : { ok: false, reason: 'That number is not a valid ID number.' };
}
