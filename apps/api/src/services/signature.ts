/**
 * Driver signature handling (Workflow C4).
 *
 * The canvas hands back a `data:image/png;base64,…` URL. We accept that or a bare
 * base64 string, but we verify the decoded bytes really are a PNG before storing
 * anything: the signature is legal evidence of who took the cylinders, and a note
 * that renders "[signature image unavailable]" because someone posted a JSON blob
 * would be worthless exactly when it is needed.
 */
import { saveFile } from './storage.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class InvalidSignatureError extends Error {}

export function decodeSignaturePng(input: string): Buffer {
  const base64 = input.startsWith('data:') ? (input.split(',', 2)[1] ?? '') : input;
  if (!base64) throw new InvalidSignatureError('Signature data URL has no payload');

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new InvalidSignatureError('Signature is not valid base64');
  }
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new InvalidSignatureError('Signature must be a PNG image');
  }
  return bytes;
}

/**
 * Written under a name derived from the idempotency key, so a retry overwrites its
 * own file rather than accumulating one per attempt.
 */
export function saveSignature(clientRequestId: string, png: Buffer): Promise<string> {
  return saveFile('signatures', `signature-${clientRequestId}.png`, png);
}
