import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  encodeQrPayloadHmac,
  verifyQrPayloadHmac,
  encodeQrPayloadEd,
  verifyQrPayloadEd,
  verifyQrPayload,
  hmacSig,
} from '../src/qr';
const SECRET = 'x'.repeat(48);
const sk = ed25519.utils.randomSecretKey();
const skHex = bytesToHex(sk);
const pkHex = bytesToHex(ed25519.getPublicKey(sk));
describe('Scheme A (HMAC / GCT1)', () => {
  it('round-trips', () => {
    const t = encodeQrPayloadHmac('NIT26-001', SECRET);
    expect(t).toMatch(/^GCT1\|NIT26-001\|[0-9a-f]{20}$/);
    expect(verifyQrPayloadHmac(t, SECRET)).toEqual({
      ok: true,
      serialCode: 'NIT26-001',
      scheme: 'hmac',
    });
  });
  it('tampered serial -> signature', () => {
    const sig = bytesToHex(hmacSig('NIT26-001', SECRET));
    expect(verifyQrPayloadHmac(`GCT1|NIT26-002|${sig}`, SECRET)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
  it('flipped sig char -> signature', () => {
    const t = encodeQrPayloadHmac('NIT26-001', SECRET).replace(/.$/, (c) =>
      c === '0' ? '1' : '0',
    );
    expect(verifyQrPayloadHmac(t, SECRET).ok).toBe(false);
  });
  it('wrong secret -> signature', () => {
    expect(verifyQrPayloadHmac(encodeQrPayloadHmac('NIT26-001', SECRET), 'y'.repeat(48))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
  it('wrong version -> version', () => {
    expect(verifyQrPayloadHmac('GCT2|NIT26-001|' + 'a'.repeat(20), SECRET)).toEqual({
      ok: false,
      reason: 'version',
    });
  });
  it('missing field / bad hex length -> format', () => {
    expect(verifyQrPayloadHmac('GCT1|NIT26-001', SECRET)).toEqual({ ok: false, reason: 'format' });
    expect(verifyQrPayloadHmac('GCT1|NIT26-001|zzzz', SECRET)).toEqual({
      ok: false,
      reason: 'format',
    });
  });
});
describe('Scheme B (Ed25519 / GCT2)', () => {
  it('round-trips', () => {
    const t = encodeQrPayloadEd('NIT26-001', skHex);
    expect(t).toMatch(/^GCT2\|NIT26-001\|[0-9a-f]{128}$/);
    expect(verifyQrPayloadEd(t, pkHex)).toEqual({
      ok: true,
      serialCode: 'NIT26-001',
      scheme: 'ed25519',
    });
  });
  it('tampered serial -> signature', () => {
    const t = encodeQrPayloadEd('NIT26-001', skHex).replace('NIT26-001', 'NIT26-002');
    expect(verifyQrPayloadEd(t, pkHex)).toEqual({ ok: false, reason: 'signature' });
  });
  it('wrong public key -> signature', () => {
    const other = bytesToHex(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
    expect(verifyQrPayloadEd(encodeQrPayloadEd('NIT26-001', skHex), other)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
  it('garbage hex -> signature (verify throws, caught)', () => {
    expect(verifyQrPayloadEd('GCT2|NIT26-001|' + 'f'.repeat(128), 'zz')).toEqual({
      ok: false,
      reason: 'signature',
    });
  });
});
describe('verifyQrPayload dispatcher', () => {
  it('routes GCT2 to ed25519', () => {
    const t = encodeQrPayloadEd('NIT26-007', skHex);
    expect(verifyQrPayload(t, { ed25519PublicKeyHex: pkHex })).toEqual({
      ok: true,
      serialCode: 'NIT26-007',
      scheme: 'ed25519',
    });
  });
  it('routes GCT1 to hmac', () => {
    const t = encodeQrPayloadHmac('NIT26-007', SECRET);
    expect(verifyQrPayload(t, { hmacSecret: SECRET })).toEqual({
      ok: true,
      serialCode: 'NIT26-007',
      scheme: 'hmac',
    });
  });
  it('unknown version -> version', () => {
    expect(verifyQrPayload('GCT9|NIT26-007|deadbeef', { hmacSecret: SECRET })).toEqual({
      ok: false,
      reason: 'version',
    });
  });
});
//# sourceMappingURL=qr.test.js.map
