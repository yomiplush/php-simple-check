#!/usr/bin/env node
/**
 * Icon generator — draws the extension icon (dark rounded square, white
 * magnifier, purple dot) at every size the manifest needs.
 *
 *   node tools/make-icons.mjs
 *
 * The generated PNGs are committed so a fresh clone can be side-loaded without
 * running anything.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // supersampling grid per axis

const COLORS = {
  background: [31, 41, 55], // #1f2937
  lens: [248, 250, 252], // #f8fafc
  dot: [139, 92, 246] // #8b5cf6
};

function roundedRectCoverage(x, y, radius) {
  // Rounded square inset by 0.06 on every side.
  const inset = 0.06;
  const min = inset;
  const max = 1 - inset;
  const r = radius;
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  const insideSquare = x >= min && x <= max && y >= min && y <= max;
  if (!insideSquare) return false;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.min(1, Math.max(0, t));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function colorAt(x, y) {
  if (!roundedRectCoverage(x, y, 0.225)) return null;

  const dotDistance = Math.hypot(x - 0.745, y - 0.245);
  if (dotDistance <= 0.105) return COLORS.dot;

  const ringDistance = Math.hypot(x - 0.43, y - 0.4);
  if (ringDistance >= 0.145 && ringDistance <= 0.245) return COLORS.lens;

  const handleDistance = segmentDistance(x, y, 0.575, 0.565, 0.78, 0.78);
  if (handleDistance <= 0.0475) return COLORS.lens;

  return COLORS.background;
}

function renderIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const step = 1 / (size * SAMPLES);
  const samplesPerPixel = SAMPLES * SAMPLES;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px = (x * SAMPLES + sx + 0.5) * step;
          const py = (y * SAMPLES + sy + 0.5) * step;
          const color = colorAt(px, py);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 255;
        }
      }

      const offset = (y * size + x) * 4;
      const covered = a / 255;
      if (covered > 0) {
        rgba[offset] = Math.round(r / covered);
        rgba[offset + 1] = Math.round(g / covered);
        rgba[offset + 2] = Math.round(b / covered);
      }
      rgba[offset + 3] = Math.round(a / samplesPerPixel);
    }
  }

  return rgba;
}

await mkdir(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const png = encodePng(size, size, renderIcon(size));
  const file = path.join(OUT_DIR, `icon${size}.png`);
  await writeFile(file, png);
  console.log(`wrote ${path.relative(ROOT, file)} (${png.length} bytes)`);
}
