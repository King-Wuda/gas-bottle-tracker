/**
 * A minimal PNG encoder, written out in full here because the app has no way to
 * rasterise anything otherwise.
 *
 * ## Why this exists at all
 *
 * The driver's signature has to reach the server as a PNG — it is embedded in the
 * signed delivery note, and `services/signature.ts` verifies the magic bytes before
 * it will store anything. On the web a `<canvas>` would do it in one call; on the
 * device there is no canvas, and the alternatives are a WebView (which is what the
 * old signature pad used, and what could not be drawn on with a finger reliably) or
 * a native screenshot library.
 *
 * Encoding it ourselves is the option that produces the SAME BYTES on both targets
 * from the same stroke data. That is worth more here than any of the alternatives:
 * per docs/WEB_PARITY.md the app is tested in a browser and shipped as an APK, and a
 * signature that renders differently on the two is a defect nobody would catch.
 *
 * ## What it supports
 *
 * Exactly what a signature needs and nothing else: 8-bit greyscale, no interlacing,
 * no palette. The deflate stream is real (an inflater must be able to read it) but
 * the compressor only looks for RUNS of the same byte. That is not a general-purpose
 * compressor — and for this input it does not need to be, because a signature is a
 * few dark pixels on a field of white, and runs are essentially all there is. It
 * takes the ~120 KB raster to a handful of kilobytes.
 */

/** CRC-32 (PNG chunk checksums), table built once on first use. */
let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32, the zlib stream checksum. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Writes bits least-significant-first, which is the order deflate uses. */
class BitWriter {
  private bytes: number[] = [];
  private current = 0;
  private used = 0;

  /** Huffman codes are defined most-significant-bit first, so they are reversed on
   *  the way in; everything else in deflate is already LSB-first. */
  push(value: number, bits: number, reverse = false): void {
    for (let i = 0; i < bits; i++) {
      const bit = reverse ? (value >> (bits - 1 - i)) & 1 : (value >> i) & 1;
      this.current |= bit << this.used;
      if (++this.used === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.used = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.used > 0) this.bytes.push(this.current);
    return Uint8Array.from(this.bytes);
  }
}

/** Fixed-Huffman literal code (RFC 1951 §3.2.6). */
function writeLiteral(w: BitWriter, byte: number): void {
  if (byte < 144) w.push(0x30 + byte, 8, true);
  else w.push(0x190 + byte - 144, 9, true);
}

/**
 * Fixed-Huffman code for a length symbol.
 *
 * The table splits at 280: 256-279 are seven bits, 280-287 are eight. Getting this
 * wrong produces a stream that inflates without error and yields the wrong bytes,
 * which is why `test/signaturePng.test.ts` inflates every output with zlib rather
 * than trusting the encoder to be self-consistent.
 */
function writeLengthCode(w: BitWriter, code: number): void {
  if (code < 280) w.push(code - 256, 7, true);
  else w.push(0xc0 + (code - 280), 8, true);
}

// Deflate's length and distance code tables, trimmed to what an RLE match needs.
const LENGTH_CODES: { code: number; base: number; extraBits: number }[] = [
  { code: 257, base: 3, extraBits: 0 },
  { code: 258, base: 4, extraBits: 0 },
  { code: 259, base: 5, extraBits: 0 },
  { code: 260, base: 6, extraBits: 0 },
  { code: 261, base: 7, extraBits: 0 },
  { code: 262, base: 8, extraBits: 0 },
  { code: 263, base: 9, extraBits: 0 },
  { code: 264, base: 10, extraBits: 0 },
  { code: 265, base: 11, extraBits: 1 },
  { code: 266, base: 13, extraBits: 1 },
  { code: 267, base: 15, extraBits: 1 },
  { code: 268, base: 17, extraBits: 1 },
  { code: 269, base: 19, extraBits: 2 },
  { code: 270, base: 23, extraBits: 2 },
  { code: 271, base: 27, extraBits: 2 },
  { code: 272, base: 31, extraBits: 2 },
  { code: 273, base: 35, extraBits: 3 },
  { code: 274, base: 43, extraBits: 3 },
  { code: 275, base: 51, extraBits: 3 },
  { code: 276, base: 59, extraBits: 3 },
  { code: 277, base: 67, extraBits: 4 },
  { code: 278, base: 83, extraBits: 4 },
  { code: 279, base: 99, extraBits: 4 },
  { code: 280, base: 115, extraBits: 4 },
  { code: 281, base: 131, extraBits: 5 },
  { code: 282, base: 163, extraBits: 5 },
  { code: 283, base: 195, extraBits: 5 },
  { code: 284, base: 227, extraBits: 5 },
  { code: 285, base: 258, extraBits: 0 },
];

/** The longest run a single match can encode. */
const MAX_MATCH = 258;
/** Shorter than this and a match costs more bits than just writing the bytes. */
const MIN_MATCH = 4;

/**
 * Deflate, restricted to literals and back-references at distance 1.
 *
 * A distance of 1 means "repeat the byte before this one", which turns any run of
 * identical bytes into a single match. Every other kind of redundancy is emitted as
 * literals, so the output is always valid — just larger than a real compressor would
 * manage on input that is not run-heavy.
 */
export function deflateRuns(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.push(1, 1); // BFINAL — one block for the whole stream
  w.push(1, 2); // BTYPE = 01, fixed Huffman codes

  let i = 0;
  while (i < data.length) {
    const byte = data[i]!;
    let run = 1;
    while (i + run < data.length && data[i + run] === byte && run < MAX_MATCH + 1) run++;

    // A match at distance 1 copies the byte just written, so the first byte of the
    // run has to be emitted as a literal before the match can refer back to it.
    if (run >= MIN_MATCH + 1) {
      writeLiteral(w, byte);
      let remaining = run - 1;
      while (remaining >= MIN_MATCH) {
        const length = Math.min(remaining, MAX_MATCH);
        // The largest code whose base does not exceed the length we want.
        let chosen = LENGTH_CODES[0]!;
        for (const c of LENGTH_CODES) if (c.base <= length) chosen = c;
        const emitted = Math.min(length, chosen.base + ((1 << chosen.extraBits) - 1));
        writeLengthCode(w, chosen.code);
        if (chosen.extraBits > 0) w.push(emitted - chosen.base, chosen.extraBits);
        w.push(0, 5, true); // distance code 0 == distance 1
        remaining -= emitted;
      }
      for (let k = 0; k < remaining; k++) writeLiteral(w, byte);
      i += run;
    } else {
      writeLiteral(w, byte);
      i += 1;
    }
  }

  writeLengthCode(w, 256); // end-of-block
  const body = w.finish();

  // zlib wrapper: CMF/FLG, then the deflate stream, then Adler-32 of the INPUT.
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  const sum = adler32(data);
  out[out.length - 4] = (sum >>> 24) & 0xff;
  out[out.length - 3] = (sum >>> 16) & 0xff;
  out[out.length - 2] = (sum >>> 8) & 0xff;
  out[out.length - 1] = sum & 0xff;
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * `grey` is one byte per pixel, row-major, 0 = black and 255 = white.
 *
 * Every scanline is written with filter type 0 (None). The filters exist to help a
 * general compressor find patterns; ours only looks for runs, and a filtered row of
 * white would be a run of zeroes just as an unfiltered one is a run of 255s — so
 * they would buy nothing and cost a branch per pixel.
 */
export function encodeGreyscalePng(width: number, height: number, grey: Uint8Array): Uint8Array {
  if (grey.length !== width * height) {
    throw new Error(`expected ${width * height} pixels, got ${grey.length}`);
  }
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: None
    raw.set(grey.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0 == greyscale
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const parts = [
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateRuns(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    png.set(p, at);
    at += p.length;
  }
  return png;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64, written out rather than reached for.
 *
 * `btoa` exists in a browser and `Buffer` exists in Node, and neither is reliably
 * present in the React Native runtime — so the one thing that must not vary between
 * the two targets is the one thing there is no shared built-in for.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}
