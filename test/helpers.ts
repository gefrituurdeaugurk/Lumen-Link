/** Test helpers: render a cell grid to RGBA the way a capture would see it. */

import { PALETTE, type CellGrid } from "../src/core/raster.ts";
import type { RgbaImage } from "../src/vision/image.ts";

export interface RenderOptions {
  /** Pixels per grid cell. */
  readonly scale?: number;
  /** White margin around the code, in pixels. */
  readonly margin?: number;
  /** Uniform additive noise amplitude, in levels. */
  readonly noise?: number;
  /** Multiplicative gain on red and blue, standing in for a green ambient
   *  that auto white balance has partially corrected. */
  readonly greenAmbient?: number;
  readonly seed?: number;
}

/** Deterministic PRNG so noisy cases stay reproducible across runs. */
function rng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderGrid(grid: CellGrid, opts: RenderOptions = {}): RgbaImage {
  const scale = opts.scale ?? 6;
  const margin = opts.margin ?? 24;
  const noise = opts.noise ?? 0;
  const tint = opts.greenAmbient ?? 0;
  const rand = rng(opts.seed ?? 1);

  const side = grid.W * scale + margin * 2;
  const data = new Uint8ClampedArray(side * side * 4);

  // Quiet margin matches the code's own white field, so the markers keep the
  // bright surround their detection depends on.
  for (let i = 0; i < side * side; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }

  for (let cy = 0; cy < grid.W; cy++) {
    for (let cx = 0; cx < grid.W; cx++) {
      const idx = grid.luma[cy * grid.W + cx] + 2 * grid.blue[cy * grid.W + cx];
      const [r, g, b] = PALETTE[idx];
      for (let dy = 0; dy < scale; dy++) {
        const y = margin + cy * scale + dy;
        for (let dx = 0; dx < scale; dx++) {
          const x = margin + cx * scale + dx;
          const o = (y * side + x) * 4;
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
        }
      }
    }
  }

  if (noise > 0 || tint > 0) {
    for (let i = 0; i < side * side; i++) {
      const o = i * 4;
      if (tint > 0) {
        data[o] = data[o] * (1 - tint);
        data[o + 2] = data[o + 2] * (1 - tint);
      }
      if (noise > 0) {
        const n = (rand() - 0.5) * noise * 2;
        data[o] += n;
        data[o + 1] += n;
        data[o + 2] += n;
      }
    }
  }

  return { data, width: side, height: side };
}

export function randomBytes(n: number, seed = 7): Uint8Array {
  const rand = rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}
