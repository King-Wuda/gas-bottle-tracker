import QRCode from 'qrcode';
import {
  encodeQrPayloadEd,
  encodeQrPayloadHmac,
  verifyQrPayload,
  type QrVerifyResult,
} from '@gct/shared';
import { env } from '../env.js';

/**
 * Builds the signed QR payload for a serial. Scheme B (Ed25519) when a signing key
 * is configured (recommended), else Scheme A (HMAC). One of the two must be set —
 * an unsigned QR would defeat the offline forgery check the scanner relies on.
 */
export function qrPayloadFor(serialCode: string): string {
  const { QR_SIGN_PRIVATE_KEY_HEX, QR_HMAC_SECRET } = env();
  if (QR_SIGN_PRIVATE_KEY_HEX) return encodeQrPayloadEd(serialCode, QR_SIGN_PRIVATE_KEY_HEX);
  if (QR_HMAC_SECRET) return encodeQrPayloadHmac(serialCode, QR_HMAC_SECRET);
  throw new Error('QR signing is not configured: set QR_SIGN_PRIVATE_KEY_HEX or QR_HMAC_SECRET');
}

/** PNG bytes for one cylinder's QR label. */
export function renderQrPng(serialCode: string): Promise<Buffer> {
  return QRCode.toBuffer(qrPayloadFor(serialCode), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
}

/**
 * Re-verifies a scanned payload server-side. The device already rejects forged codes
 * offline, but that check runs on hardware we do not control — a tampered client
 * could POST any serial it likes. Verifying here means a scan is only accepted if the
 * submitter genuinely held a label this server signed.
 */
export function verifyScannedPayload(payload: string): QrVerifyResult {
  const { QR_SIGN_PUBLIC_KEY_HEX, QR_HMAC_SECRET } = env();
  return verifyQrPayload(payload, {
    ed25519PublicKeyHex: QR_SIGN_PUBLIC_KEY_HEX,
    hmacSecret: QR_HMAC_SECRET,
  });
}
