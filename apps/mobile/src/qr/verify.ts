import { verifyQrPayload, type QrVerifyResult } from '@gct/shared';

/**
 * Offline verification of a scanned label.
 *
 * The device carries only the Ed25519 PUBLIC key, so it can prove a sticker was
 * issued by this server but cannot mint one. That is the whole point of Scheme B:
 * a technician in a basement with no signal can still reject a photocopied or
 * hand-printed code on the spot, instead of discovering it days later on sync.
 */
const PUBLIC_KEY = process.env.EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY;

export function verifyScannedCode(text: string): QrVerifyResult {
  if (!PUBLIC_KEY) {
    // Misconfiguration, not a forged label — say so rather than blaming the sticker.
    throw new Error(
      'EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY is not set; scanned codes cannot be verified.',
    );
  }
  return verifyQrPayload(text, { ed25519PublicKeyHex: PUBLIC_KEY });
}

export const qrVerificationConfigured = Boolean(PUBLIC_KEY);
