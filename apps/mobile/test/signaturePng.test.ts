import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { deflateRuns, encodeGreyscalePng, toBase64 } from '../src/signature/png';
import {
  fitPad,
  hasInk,
  rasteriseStrokes,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  renderSignature,
  type Stroke,
} from '../src/signature/raster';

/**
 * The encoder is hand-written (see `src/signature/png.ts` for why), so it is checked
 * against a real inflater rather than against itself. A deflate stream with the wrong
 * Huffman code widths decodes WITHOUT ERROR into the wrong bytes, so "it round-trips
 * through zlib and the bytes match" is the only assertion worth making.
 */
describe('deflateRuns', () => {
  const roundTrip = (bytes: Uint8Array) =>
    new Uint8Array(inflateSync(Buffer.from(deflateRuns(bytes))));

  it('round-trips an empty input', () => {
    expect(roundTrip(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it('round-trips every byte value, which crosses the 144-literal code split', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(roundTrip(all)).toEqual(all);
  });

  it('round-trips runs at every length around the code boundaries', () => {
    // 116 and 259 straddle the 7-bit/8-bit length code split and the 258-byte
    // maximum match — the two places an off-by-one produces valid-but-wrong output.
    for (const length of [1, 2, 3, 4, 5, 115, 116, 117, 257, 258, 259, 600, 1024]) {
      const run = new Uint8Array(length).fill(0xff);
      expect(roundTrip(run), `run of ${length}`).toEqual(run);
    }
  });

  it('round-trips a realistic scanline: white with a few dark pixels', () => {
    const row = new Uint8Array(600).fill(255);
    row.set([12, 0, 0, 40, 200], 300);
    expect(roundTrip(row)).toEqual(row);
  });

  it('round-trips random data, where nothing can be matched', () => {
    let seed = 7;
    const noise = Uint8Array.from({ length: 5000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) & 0xff;
    });
    expect(roundTrip(noise)).toEqual(noise);
  });

  it('actually compresses a run-heavy input', () => {
    const mostlyWhite = new Uint8Array(120_000).fill(255);
    expect(deflateRuns(mostlyWhite).length).toBeLessThan(2_000);
  });
});

describe('encodeGreyscalePng', () => {
  const strokes: Stroke[] = [
    [
      { x: 10, y: 40 },
      { x: 60, y: 10 },
      { x: 110, y: 55 },
      { x: 160, y: 12 },
    ],
  ];

  it('produces a file a decoder recognises as a PNG', () => {
    const png = encodeGreyscalePng(4, 2, Uint8Array.from([0, 64, 128, 255, 255, 128, 64, 0]));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(Buffer.from(png.subarray(12, 16)).toString()).toBe('IHDR');
    // IHDR body: width, height, bit depth, colour type
    const header = new DataView(png.buffer, png.byteOffset);
    expect(header.getUint32(16)).toBe(4);
    expect(header.getUint32(20)).toBe(2);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(0);
    expect(Buffer.from(png.subarray(png.length - 8, png.length - 4)).toString()).toBe('IEND');
  });

  it('round-trips the pixels through the IDAT stream', () => {
    const pixels = Uint8Array.from([0, 64, 128, 255, 255, 128, 64, 0]);
    const png = encodeGreyscalePng(4, 2, pixels);
    // IDAT starts after the 8-byte magic and the 25-byte IHDR chunk.
    const idatStart = 8 + 25;
    const idatLength = new DataView(png.buffer, png.byteOffset).getUint32(idatStart);
    const raw = new Uint8Array(
      inflateSync(Buffer.from(png.subarray(idatStart + 8, idatStart + 8 + idatLength))),
    );
    // Each scanline is prefixed with its filter byte (0 = None).
    expect([...raw]).toEqual([0, 0, 64, 128, 255, 0, 255, 128, 64, 0]);
  });

  it('refuses a pixel buffer that does not match the dimensions', () => {
    expect(() => encodeGreyscalePng(4, 2, new Uint8Array(7))).toThrow(/expected 8 pixels/);
  });

  it('rasterises strokes as dark pixels on white, inside the canvas', () => {
    const grey = rasteriseStrokes(strokes, fitPad(600, 220));
    expect(grey.length).toBe(SIGNATURE_WIDTH * SIGNATURE_HEIGHT);
    expect(grey.some((v) => v < 40)).toBe(true);
    // The strokes occupy the top-left; the far corner must be untouched white.
    expect(grey[SIGNATURE_WIDTH * SIGNATURE_HEIGHT - 1]).toBe(255);
  });

  it('clips strokes drawn outside the canvas instead of throwing', () => {
    const outside: Stroke[] = [
      [
        { x: -400, y: -400 },
        { x: 4000, y: 4000 },
      ],
    ];
    expect(() => rasteriseStrokes(outside, fitPad(600, 220))).not.toThrow();
  });

  it('emits a data URL the API will accept, and a small one', () => {
    const { dataUrl: url, inkedPixels } = renderSignature(strokes, 300, 220);
    expect(inkedPixels).toBeGreaterThan(0);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const bytes = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Comfortably inside `signaturePngSchema`'s 2.8 MB ceiling, and small enough to
    // sit in an outbox row next to a base64 photo without bloating it.
    expect(url.length).toBeLessThan(60_000);
    // And past its 64-character floor, so an empty pad is the only thing that can
    // fail that check.
    expect(url.length).toBeGreaterThan(64);
  });

  it('reports zero ink for strokes that never landed on the canvas', () => {
    // The real defect this guards: a pad whose coordinate origin was stale recorded
    // strokes hundreds of pixels above the canvas. `hasInk` was true, the PNG was
    // valid, and the signature was blank. Only the raster can tell you that.
    const offCanvas: Stroke[] = [
      [
        { x: 40, y: -900 },
        { x: 260, y: -880 },
      ],
    ];
    expect(hasInk(offCanvas)).toBe(true);
    const { dataUrl, inkedPixels } = renderSignature(offCanvas, 300, 220);
    expect(inkedPixels).toBe(0);
    // Still a structurally valid PNG — which is exactly why the count is needed.
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('counts ink for a signature drawn in the middle of the pad', () => {
    const { inkedPixels } = renderSignature(strokes, 300, 220);
    expect(inkedPixels).toBeGreaterThan(200);
  });

  it('fits the pad into the raster without distorting or clipping it', () => {
    // The pad is wider than it is tall in a different ratio from the output raster,
    // so one scale per axis is the only mapping that keeps a signature its own shape.
    // Scaling by width alone ran a 372x220 pad off the bottom of a 600x220 canvas and
    // clipped the descenders — which is what this pins down.
    const fit = fitPad(372, 220);
    expect(fit.scale).toBeCloseTo(1, 5);
    expect(fit.offsetY).toBeCloseTo(0, 5);
    expect(fit.offsetX).toBeCloseTo((600 - 372) / 2, 5);

    // A stroke along the very bottom of the pad must still land inside the raster.
    const alongTheBottom: Stroke[] = [
      [
        { x: 10, y: 215 },
        { x: 360, y: 215 },
      ],
    ];
    const { inkedPixels } = renderSignature(alongTheBottom, 372, 220);
    expect(inkedPixels).toBeGreaterThan(300);
  });

  it('shrinks a pad larger than the raster rather than cropping it', () => {
    const fit = fitPad(1200, 440);
    expect(fit.scale).toBeCloseTo(0.5, 5);
    const corner: Stroke[] = [
      [
        { x: 1190, y: 430 },
        { x: 1195, y: 435 },
      ],
    ];
    expect(renderSignature(corner, 1200, 440).inkedPixels).toBeGreaterThan(0);
  });

  it('base64-encodes with the right padding for every input length', () => {
    expect(toBase64(Uint8Array.from([0x4d]))).toBe('TQ==');
    expect(toBase64(Uint8Array.from([0x4d, 0x61]))).toBe('TWE=');
    expect(toBase64(Uint8Array.from([0x4d, 0x61, 0x6e]))).toBe('TWFu');
    const bytes = Uint8Array.from({ length: 253 }, (_, i) => (i * 7) % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('hasInk', () => {
  it('is false for an untouched pad and for a stray tap', () => {
    expect(hasInk([])).toBe(false);
    expect(hasInk([[{ x: 1, y: 1 }]])).toBe(false);
  });

  it('is true once something has actually been drawn', () => {
    expect(
      hasInk([
        [
          { x: 1, y: 1 },
          { x: 9, y: 9 },
        ],
      ]),
    ).toBe(true);
  });
});
