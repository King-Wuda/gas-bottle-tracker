/**
 * Generates the GEA artwork used by the app.
 *
 *     npm i --no-save @resvg/resvg-js && node scripts/gen-logo.mjs
 *
 * The rasteriser is installed on demand rather than carried as a devDependency: this
 * runs when the brand artwork changes, which is roughly never, and everyone else would
 * otherwise pay to install a native module they will not use.
 *
 * Two files come out, because one drawing does not serve both jobs:
 *
 *   gea-logo.png  the full lockup — the letters plus "Engineering for a better
 *                 world." Used wherever there is room to read it.
 *   gea-mark.png  the letters alone. Used where the lockup would be illegible or
 *                 absurd: the nav bar's right edge, and the rockets, whose bodies
 *                 are 92px wide.
 *
 * ## Provenance
 *
 * This is a REDRAW, built from the screenshot supplied with the request — vector
 * paths at a size the screenshot could never provide. It is close, not identical:
 * the letterforms are a custom typeface and the strike's exact geometry cannot be
 * recovered from a 230px image. If GEA supply the real EPS/SVG, render it to these
 * two filenames and re-run `gen-assets.mjs`; nothing else changes.
 */
import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, '../assets');

const BLUE = '#1414C8';
/** Constant stroke weight: the mark is outlined letterforms, not solid ones. */
const S = 10;
const H = 92; // cap height
const T = 4; // top of the letters
const MARK_W = 254; // where the letters end and the tagline may begin

const gcx = 52,
  gcy = T + H / 2,
  gr = 44;
const G = `
  <path d="M ${gcx + gr} ${gcy - 14} A ${gr} ${gr} 0 1 0 ${gcx + gr} ${gcy + 14}"
        fill="none" stroke="${BLUE}" stroke-width="${S}"/>
  <path d="M ${gcx + 6} ${gcy} H ${gcx + gr}" fill="none" stroke="${BLUE}" stroke-width="${S}"/>
  <path d="M ${gcx + gr} ${gcy - 14} V ${gcy + 14}" fill="none" stroke="${BLUE}" stroke-width="${S}"/>`;

const ex = 110,
  ew = 52;
const E = `
  <path d="M ${ex} ${T} H ${ex + ew} M ${ex} ${T + H / 2} H ${ex + ew - 10}
           M ${ex} ${T + H} H ${ex + ew} M ${ex} ${T} V ${T + H}"
        fill="none" stroke="${BLUE}" stroke-width="${S}"/>`;

const ax = 174,
  aw = 70;
const A = `
  <path d="M ${ax} ${T + H} L ${ax + aw / 2} ${T} L ${ax + aw} ${T + H}"
        fill="none" stroke="${BLUE}" stroke-width="${S}"/>
  <path d="M ${ax + 12} ${T + H / 2 + 16} H ${ax + aw - 12}"
        fill="none" stroke="${BLUE}" stroke-width="${S}"/>`;

/**
 * The diagonal. It reads as a CUT — a white gap knocked through the letters with a
 * thin blue rule along its lower edge — rather than as a bar laid on top of them,
 * which is the difference between the real mark and a struck-through word.
 */
const STRIKE = `
  <path d="M 2 ${T + H + 2} L 248 ${T + 26}" stroke="#fff" stroke-width="14" fill="none"/>
  <path d="M 2 ${T + H + 7} L 248 ${T + 31}" stroke="${BLUE}" stroke-width="5" fill="none"/>`;

const TAG_X = 268;
const TAGLINE = `
  <g fill="${BLUE}" font-family="DejaVu Sans" font-size="20">
    <text x="${TAG_X}" y="${T + 20}">Engineering</text>
    <text x="${TAG_X}" y="${T + 44}">for a better</text>
    <text x="${TAG_X}" y="${T + 68}">world.</text>
  </g>`;

const VB_H = 112;
const svg = (width, withTagline) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${VB_H}" width="${width}" height="${VB_H}">` +
  `${G}${E}${A}${STRIKE}${withTagline ? TAGLINE : ''}</svg>`;

for (const [name, width, withTagline, render] of [
  ['gea-logo', 470, true, 1400],
  ['gea-mark', MARK_W, false, 760],
]) {
  const markup = svg(width, withTagline);
  writeFileSync(path.join(assets, `${name}.svg`), markup);
  const png = new Resvg(markup, { fitTo: { mode: 'width', value: render } }).render().asPng();
  writeFileSync(path.join(assets, `${name}.png`), png);
  console.log(
    `${name}.png  ${png.length} bytes  viewBox ${width}x${VB_H}  ratio ${(width / VB_H).toFixed(3)}`,
  );
}
