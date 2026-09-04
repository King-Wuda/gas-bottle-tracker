import { encodeGreyscalePng, toBase64 } from './png';

/**
 * Turning the strokes drawn on the signature pad into the PNG the API stores.
 *
 * This runs identically on both targets — it is arithmetic over a byte array, with
 * nothing platform-specific in it — which is the whole reason the pad draws into a
 * model instead of into a canvas. See `png.ts` for why we rasterise at all.
 */

/** A point in the pad's own coordinate space, in device-independent pixels. */
export interface Point {
  x: number;
  y: number;
}

/** One continuous press-move-release. */
export type Stroke = Point[];

/**
 * The output raster. Fixed rather than derived from the on-screen pad so that the
 * delivery note prints the same size signature whatever phone it was signed on, and
 * so a tablet does not produce a five-megapixel PNG for a squiggle.
 */
export const SIGNATURE_WIDTH = 600;
export const SIGNATURE_HEIGHT = 220;

/** Pen radius in output pixels. 1.6 keeps a thin stroke legible after the delivery
 *  note scales it into a 220pt-wide box. */
const PEN_RADIUS = 1.6;

/** Squared distance from `p` to the segment `a`-`b`, and nothing else — the inner
 *  loop of the rasteriser, called once per pixel per segment. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  // A zero-length segment is a dot — a tap rather than a stroke, which is a real
  // thing people do to a signature pad, so it has to draw something.
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** How the pad's on-screen box maps onto the output raster. */
export interface PadFit {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Fit the pad's box inside the output raster without distorting it.
 *
 * ONE scale for both axes, and the leftover space split evenly. Scaling the axes
 * independently would stretch a signature to the raster's proportions; scaling by
 * width alone — which this did at first — runs a 372x220 pad off the bottom of a
 * 600x220 canvas and quietly clips the descenders off the driver's name.
 */
export function fitPad(padWidth: number, padHeight: number): PadFit {
  if (padWidth <= 0 || padHeight <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min(SIGNATURE_WIDTH / padWidth, SIGNATURE_HEIGHT / padHeight);
  return {
    scale,
    offsetX: (SIGNATURE_WIDTH - padWidth * scale) / 2,
    offsetY: (SIGNATURE_HEIGHT - padHeight * scale) / 2,
  };
}

/**
 * Draw the strokes onto a white greyscale raster.
 *
 * `fit` maps the pad's on-screen coordinates onto the output raster, so the same
 * signature comes out the same size and shape from a narrow phone and a wide browser
 * window.
 *
 * Anti-aliased, by giving each pixel the ink coverage implied by its distance from
 * the stroke's centre line. Without it a signature at this size is a staircase, and
 * a staircase is what makes a scanned-looking document look forged.
 */
export function rasteriseStrokes(strokes: Stroke[], fit: PadFit): Uint8Array {
  const grey = new Uint8Array(SIGNATURE_WIDTH * SIGNATURE_HEIGHT).fill(255);
  const reach = PEN_RADIUS + 1;

  const ink = (x: number, y: number, coverage: number): void => {
    if (coverage <= 0 || x < 0 || y < 0 || x >= SIGNATURE_WIDTH || y >= SIGNATURE_HEIGHT) return;
    const at = y * SIGNATURE_WIDTH + x;
    const value = Math.round(255 * (1 - Math.min(1, coverage)));
    // Darkest wins, so a stroke crossing itself does not lighten where it overlaps.
    if (value < grey[at]!) grey[at] = value;
  };

  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    // A single-point stroke is still a mark: repeat it so the segment loop draws a dot.
    const points = stroke.length === 1 ? [stroke[0]!, stroke[0]!] : stroke;
    for (let i = 1; i < points.length; i++) {
      const ax = points[i - 1]!.x * fit.scale + fit.offsetX;
      const ay = points[i - 1]!.y * fit.scale + fit.offsetY;
      const bx = points[i]!.x * fit.scale + fit.offsetX;
      const by = points[i]!.y * fit.scale + fit.offsetY;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
      const maxX = Math.min(SIGNATURE_WIDTH - 1, Math.ceil(Math.max(ax, bx) + reach));
      const minY = Math.max(0, Math.floor(Math.min(ay, by) - reach));
      const maxY = Math.min(SIGNATURE_HEIGHT - 1, Math.ceil(Math.max(ay, by) + reach));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const d = distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
          ink(x, y, PEN_RADIUS + 0.5 - d);
        }
      }
    }
  }
  return grey;
}

/** True when there is anything on the pad at all — one stroke with two points. A
 *  stray tap while handing the phone over is not a signature. */
export function hasInk(strokes: Stroke[]): boolean {
  return strokes.some((s) => s.length >= 2);
}

/** Anything at or below this is ink rather than paper. Only used for the sanity
 *  count below; the raster itself keeps its full anti-aliased range. */
const INK_THRESHOLD = 250;

/**
 * The whole pad -> `data:image/png;base64,…` the API accepts.
 *
 * `padWidth`/`padHeight` are the pad's on-screen box; the drawing is fitted into the
 * output raster from them, so the signature keeps its shape and its position on the
 * pad whatever size the screen was.
 *
 * ## Why it counts the ink it drew
 *
 * `hasInk` says the person moved their finger. It does NOT say the result landed on
 * the canvas — strokes recorded in the wrong coordinate space are still strokes, and
 * they rasterise to a perfectly valid, perfectly blank PNG. That failure already
 * happened once here (the pad's origin was measured before its scroll view had
 * scrolled), and it is the worst possible kind: the submission succeeds, the delivery
 * note renders, and the signature that proves who took the cylinders is white paper.
 *
 * So the count comes back with the image and the caller refuses to submit a blank
 * one. A signature nobody can see is not evidence, and it must fail loudly at the
 * gate rather than quietly in the archive.
 */
export function renderSignature(
  strokes: Stroke[],
  padWidth: number,
  padHeight: number,
): { dataUrl: string; inkedPixels: number } {
  const grey = rasteriseStrokes(strokes, fitPad(padWidth, padHeight));
  let inkedPixels = 0;
  for (let i = 0; i < grey.length; i++) if (grey[i]! <= INK_THRESHOLD) inkedPixels++;
  const png = encodeGreyscalePng(SIGNATURE_WIDTH, SIGNATURE_HEIGHT, grey);
  return { dataUrl: `data:image/png;base64,${toBase64(png)}`, inkedPixels };
}
