/**
 * Isomorphic QR encode/verify. This module runs in BOTH Fastify (Node) and React
 * Native, so it is built on @noble/* (pure JS) — never node:crypto, which does not
 * exist in RN.
 *
 * Payload: pipe-delimited  GCT<ver>|<serialCode>|<sigHex>
 *  - Scheme A  GCT1: truncated HMAC-SHA256 (symmetric). Small QR, but the signing
 *                    secret must ship in the app to verify offline.
 *  - Scheme B  GCT2: Ed25519 signature (asymmetric). Server signs with a private
 *                    key; the app carries only the public key and cannot forge.
 *                    RECOMMENDED — genuine offline rejection of forged/foreign codes.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { SERIAL_CODE_RE } from './serial';

export const QR_FIELD_SEP = '|';

/** Isomorphic constant-time byte compare (JS timing safety is best-effort). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export type QrVerifyResult =
  | { ok: true; serialCode: string; scheme: 'hmac' | 'ed25519' }
  | { ok: false; reason: 'format' | 'version' | 'signature' };

// ---- Scheme A: truncated HMAC (symmetric) ----
export const QR_VERSION_HMAC = 'GCT1';
const HMAC_SIG_BYTES = 10; // 10 bytes -> 20 hex chars
const HMAC_SIG_HEX_RE = /^[0-9a-f]{20}$/i;

export function hmacSig(serialCode: string, secret: string): Uint8Array {
  return hmac(sha256, utf8ToBytes(secret), utf8ToBytes(serialCode)).subarray(0, HMAC_SIG_BYTES);
}

export function encodeQrPayloadHmac(serialCode: string, secret: string): string {
  if (!SERIAL_CODE_RE.test(serialCode))
    throw new Error(`encodeQrPayload: bad serial ${serialCode}`);
  return [QR_VERSION_HMAC, serialCode, bytesToHex(hmacSig(serialCode, secret))].join(QR_FIELD_SEP);
}

export function verifyQrPayloadHmac(text: string, secret: string): QrVerifyResult {
  const parts = text.split(QR_FIELD_SEP);
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [ver, serialCode, sigHex] = parts as [string, string, string];
  if (ver !== QR_VERSION_HMAC) return { ok: false, reason: 'version' };
  if (!SERIAL_CODE_RE.test(serialCode) || !HMAC_SIG_HEX_RE.test(sigHex)) {
    return { ok: false, reason: 'format' };
  }
  if (!timingSafeEqualBytes(hexToBytes(sigHex), hmacSig(serialCode, secret))) {
    return { ok: false, reason: 'signature' };
  }
  return { ok: true, serialCode, scheme: 'hmac' };
}

// ---- Scheme B: Ed25519 (asymmetric, RECOMMENDED) ----
export const QR_VERSION_ED = 'GCT2';
const ED_SIG_HEX_RE = /^[0-9a-f]{128}$/i; // 64-byte signature

export function encodeQrPayloadEd(serialCode: string, privKeyHex: string): string {
  if (!SERIAL_CODE_RE.test(serialCode))
    throw new Error(`encodeQrPayload: bad serial ${serialCode}`);
  const sig = ed25519.sign(utf8ToBytes(serialCode), hexToBytes(privKeyHex));
  return [QR_VERSION_ED, serialCode, bytesToHex(sig)].join(QR_FIELD_SEP);
}

export function verifyQrPayloadEd(text: string, pubKeyHex: string): QrVerifyResult {
  const parts = text.split(QR_FIELD_SEP);
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [ver, serialCode, sigHex] = parts as [string, string, string];
  if (ver !== QR_VERSION_ED) return { ok: false, reason: 'version' };
  if (!SERIAL_CODE_RE.test(serialCode) || !ED_SIG_HEX_RE.test(sigHex)) {
    return { ok: false, reason: 'format' };
  }
  try {
    const valid = ed25519.verify(
      hexToBytes(sigHex),
      utf8ToBytes(serialCode),
      hexToBytes(pubKeyHex),
    );
    return valid ? { ok: true, serialCode, scheme: 'ed25519' } : { ok: false, reason: 'signature' };
  } catch {
    return { ok: false, reason: 'signature' };
  }
}

/** Version-dispatching verify: picks the scheme from the payload prefix. */
export function verifyQrPayload(
  text: string,
  opts: { hmacSecret?: string; ed25519PublicKeyHex?: string },
): QrVerifyResult {
  const ver = text.split(QR_FIELD_SEP, 1)[0];
  if (ver === QR_VERSION_ED && opts.ed25519PublicKeyHex) {
    return verifyQrPayloadEd(text, opts.ed25519PublicKeyHex);
  }
  if (ver === QR_VERSION_HMAC && opts.hmacSecret) {
    return verifyQrPayloadHmac(text, opts.hmacSecret);
  }
  return { ok: false, reason: 'version' };
}
