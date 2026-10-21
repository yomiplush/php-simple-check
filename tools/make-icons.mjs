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

/**
 * The action icon doubles as the verdict display: the square takes the verdict
 * colour so a glance at the toolbar is enough. "idle" is the neutral icon used
 * before a page has been judged (and for the store/management pages).
 */
const PALETTES = {
  idle: {
    background: [31, 41, 55], // #1f2937
    lens: [248, 250, 252], // #f8fafc
    dot: [139, 92, 246] // #8b5cf6
  },
  php: {
    background: [198, 40, 40], // #c62828 — white lens keeps 4.5:1 contrast
    lens: [255, 255, 255],
    dot: [255, 205, 210] // #ffcdd2
  },
  maybe: {
    background: [178, 106, 0], // #b26a00
    lens: [255, 255, 255],
    dot: [255, 224, 178] // #ffe0b2
  },
  none: {
    background: [46, 125, 50], // #2e7d32
    lens: [255, 255, 255],
    dot: [200, 230, 201] // #c8e6c9
  }
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

function colorAt(x, y, palette) {
  if (!roundedRectCoverage(x, y, 0.225)) return null;

  const dotDistance = Math.hypot(x - 0.745, y - 0.245);
  if (dotDistance <= 0.105) return palette.dot;

  const ringDistance = Math.hypot(x - 0.43, y - 0.4);
  if (ringDistance >= 0.145 && ringDistance <= 0.245) return palette.lens;

  const handleDistance = segmentDistance(x, y, 0.575, 0.565, 0.78, 0.78);
  if (handleDistance <= 0.0475) return palette.lens;

  return palette.background;
}

export function renderIcon(size, palette) {
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
          const color = colorAt(px, py, palette);
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

export async function generate(options = {}) {
  const outDir = options.outDir || OUT_DIR;
  const sizes = options.sizes || SIZES;
  const states = options.states || Object.keys(PALETTES);
  const prefix = options.prefix || '';

  await mkdir(outDir, { recursive: true });

  for (const name of states) {
    const palette = PALETTES[name];
    for (const size of sizes) {
      const fileName = name === 'idle' ? `icon${size}.png` : `status-${name}-${size}.png`;
      const file = path.join(outDir, `${prefix}${fileName}`);
      const png = encodePng(size, size, renderIcon(size, palette));
      await writeFile(file, png);
      console.log(`wrote ${file} (${png.length} bytes)`);
    }
  }
}

// CLI: node tools/make-icons.mjs [--out=DIR] [--sizes=16,32] [--states=idle] [--prefix=x-]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((argument) => {
      const [key, value] = argument.replace(/^--/, '').split('=');
      return [key, value];
    })
  );
  await generate({
    outDir: args.out,
    sizes: args.sizes ? args.sizes.split(',').map(Number) : undefined,
    states: args.states ? args.states.split(',') : undefined,
    prefix: args.prefix
  });
}
