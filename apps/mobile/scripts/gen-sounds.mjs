/**
 * Generates the two UI sounds as 16-bit mono WAV files.
 *
 *     node scripts/gen-sounds.mjs
 *
 * They are SYNTHESISED rather than sampled so that the repo stays free of assets
 * with unclear licensing, and so that either can be re-tuned by changing a number
 * here instead of by finding a new recording. Both are deliberately short and quiet:
 * the scan beep fires once per cylinder and a batch can be forty of them.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/sounds');

/** float samples in [-1, 1] -> a mono 16-bit PCM WAV file */
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const frames = (seconds) => Math.round(seconds * RATE);

/** Seeded, so regenerating the files byte-for-byte reproduces them — an asset that
 *  changes every time it is rebuilt turns every `git status` into a false alarm. */
let seed = 0x2f6e2b1;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed |= 0;
  return (seed >>> 0) / 0xffffffff;
};

/**
 * The scan confirmation — one clean tone, the sound a supermarket scanner makes.
 *
 * 2100 Hz sits above the noise of a yard without being shrill on a phone speaker.
 * The 3 ms attack matters more than it looks: a tone that starts instantly at full
 * amplitude clicks, and forty clicks in a row is what makes an app feel cheap.
 */
function beep() {
  const n = frames(0.09);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const attack = Math.min(1, t / 0.003);
    const release = Math.min(1, (n - i) / RATE / 0.02);
    out[i] = 0.32 * attack * release * Math.sin(2 * Math.PI * 2100 * t);
  }
  return out;
}

/**
 * The submission sound — a steel cylinder being knocked.
 *
 * A struck cylinder is a ringing shell, not a pitch: its partials are INHARMONIC
 * (the ratios below are typical of a thin steel tube) and the high ones die away
 * much faster than the low ones, which is what makes metal sound like metal rather
 * than like an organ. The noise burst at the front is the strike itself — without a
 * transient the ring sounds synthesised, because nothing was actually hit.
 */
function clang() {
  const n = frames(0.75);
  const out = new Float32Array(n);
  const f0 = 196;
  const partials = [
    { ratio: 1, amp: 0.5, decay: 0.42 },
    { ratio: 2.71, amp: 0.34, decay: 0.3 },
    { ratio: 4.13, amp: 0.22, decay: 0.2 },
    { ratio: 6.87, amp: 0.14, decay: 0.13 },
    { ratio: 10.4, amp: 0.08, decay: 0.08 },
  ];
  // One-pole low-pass on the strike noise so it reads as a dull knock on steel
  // rather than as a hiss.
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = 0;
    for (const p of partials)
      v += p.amp * Math.exp(-t / p.decay) * Math.sin(2 * Math.PI * f0 * p.ratio * t);
    const noise = (rand() * 2 - 1) * Math.exp(-t / 0.012);
    lp += 0.25 * (noise - lp);
    v = v * 0.62 + lp * 0.9;
    out[i] = v * Math.min(1, t / 0.001) * Math.min(1, (n - i) / RATE / 0.05);
  }
  // Normalise to a fixed peak so the two cues sit at comparable loudness.
  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.7;
  return out;
}

mkdirSync(outDir, { recursive: true });
for (const [name, samples] of [
  ['scan-beep.wav', beep()],
  ['cylinder-clang.wav', clang()],
]) {
  const bytes = wav(samples);
  writeFileSync(path.join(outDir, name), bytes);
  console.log(name, bytes.length, 'bytes');
}
