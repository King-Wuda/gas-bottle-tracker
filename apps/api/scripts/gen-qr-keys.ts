/**
 * One-off Ed25519 keypair generator for QR Scheme B (GCT2).
 * Run:  npx tsx apps/api/scripts/gen-qr-keys.ts
 *
 *  QR_SIGN_PRIVATE_KEY_HEX  -> apps/api/.env only (never shipped to a device)
 *  QR_SIGN_PUBLIC_KEY_HEX   -> apps/api/.env  AND  apps/mobile EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const sk = ed25519.utils.randomSecretKey();
const pk = ed25519.getPublicKey(sk);

console.log('QR_SIGN_PRIVATE_KEY_HEX=' + bytesToHex(sk));
console.log('QR_SIGN_PUBLIC_KEY_HEX=' + bytesToHex(pk));
