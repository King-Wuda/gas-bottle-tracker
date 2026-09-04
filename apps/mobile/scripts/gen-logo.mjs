import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';

const H = 200,
  W = 52,
  R = 100,
  r = R - W,
  cx = 100,
  cy = 100;
const rad = (d) => (d * Math.PI) / 180;
const pt = (deg, R_) => [cx + R_ * Math.cos(rad(deg)), cy - R_ * Math.sin(rad(deg))];
const f = (n) => n.toFixed(2);
/** angle on a circle of radius R_ whose point sits at height y, on the right half */
const angleAtY = (y, R_) => (Math.asin((cy - y) / R_) * 180) / Math.PI;

// --- G ---------------------------------------------------------------------
// A ring whose aperture is cut horizontally top and bottom (a radial cut reads as a
// swoosh, which is not what the wordmark does), closed by a mid-height spur bar that
// runs from inside the bowl out to the right edge.
const TOP_CUT = 56,
  BOT_CUT = 100; // y of the aperture's two lips
const [gox, goy] = pt(angleAtY(TOP_CUT, R), R); // outer, top lip
const [gix, giy] = pt(angleAtY(TOP_CUT, r), r); // inner, top lip
const [box_, boy] = pt(angleAtY(BOT_CUT, R), R); // outer, bottom lip
const [bix, biy] = pt(angleAtY(BOT_CUT, r), r); // inner, bottom lip
const gRing =
  `M ${f(gox)},${f(goy)} A ${R},${R} 0 1 0 ${f(box_)},${f(boy)} ` +
  `L ${f(bix)},${f(biy)} A ${r},${r} 0 1 1 ${f(gix)},${f(giy)} Z`;
// The spur. Starts left of the bowl's inner edge so it reads as a bar crossing into
// the counter rather than as a thickening of the ring.
const gBar = `M 96,${BOT_CUT} H 200 V ${BOT_CUT + 48} H 96 Z`;

// --- E ---------------------------------------------------------------------
const EW = 154,
  ARM = 52,
  MIDARM = 48;
const eParts = [
  `M 0,0 H ${W} V ${H} H 0 Z`,
  `M 0,0 H ${EW} V ${ARM} H 0 Z`,
  `M 0,${(H - MIDARM) / 2} H ${EW - 20} V ${(H + MIDARM) / 2} H 0 Z`,
  `M 0,${H - ARM} H ${EW} V ${H} H 0 Z`,
];

// --- A ---------------------------------------------------------------------
const AW = 200,
  INNER_APEX_Y = 50,
  INNER_BASE = 54;
const outerX = (y) => (AW / 2) * (1 - y / H);
const aOuter =
  `M 0,${H} L ${AW / 2},0 L ${AW},${H} L ${AW - INNER_BASE},${H} ` +
  `L ${AW / 2},${INNER_APEX_Y} L ${INNER_BASE},${H} Z`;
const CB_TOP = 124,
  CB_BOT = 170;
const aBar =
  `M ${f(outerX(CB_TOP))},${CB_TOP} L ${f(AW - outerX(CB_TOP))},${CB_TOP} ` +
  `L ${f(AW - outerX(CB_BOT))},${CB_BOT} L ${f(outerX(CB_BOT))},${CB_BOT} Z`;

// --- layout ----------------------------------------------------------------
const GAP = 32,
  PAD = 12;
const xE = 200 + GAP,
  xA = xE + EW + GAP;
const VB_W = xA + AW + PAD * 2,
  VB_H = H + PAD * 2;

const svg = (
  blue,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}" width="${VB_W}" height="${VB_H}">
  <g fill="${blue}" transform="translate(${PAD},${PAD})">
    <path d="${gRing}"/><path d="${gBar}"/>
    <g transform="translate(${xE},0)">${eParts.map((d) => `<path d="${d}"/>`).join('')}</g>
    <g transform="translate(${xA},0)"><path d="${aOuter}"/><path d="${aBar}"/></g>
  </g>
</svg>`;

const out = process.argv[2],
  blue = process.argv[3] ?? '#0A3CA8';
const width = Number(process.argv[4] ?? 1220);
writeFileSync(out.replace(/\.png$/, '.svg'), svg(blue));
const png = new Resvg(svg(blue), { fitTo: { mode: 'width', value: width } }).render().asPng();
writeFileSync(out, png);
console.log(
  out,
  png.length,
  'bytes,  viewBox',
  VB_W,
  'x',
  VB_H,
  ' ratio',
  (VB_W / VB_H).toFixed(2),
);
