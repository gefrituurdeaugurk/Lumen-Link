/** Test helpers: render a cell grid to RGBA the way a capture would see it. */

import { PALETTE, type CellGrid } from "../src/core/raster.ts";
import { homography, applyHomography } from "../src/vision/homography.ts";
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

export interface SceneOptions extends RenderOptions {
  /** Frame width in pixels; height follows a 16:9 sensor. */
  readonly frameWidth?: number;
  /** Fraction of the frame width the screen occupies. */
  readonly fill?: number;
  /** Bezel and room brightness, 0..255. */
  readonly room?: number;
  /** Illumination falloff corner to corner, 0..1. A phone pointed at a screen
   *  never sees an evenly lit one. */
  readonly gradient?: number;
  /** Dark rectangles scattered outside the screen — furniture, cables. */
  readonly clutter?: number;
  /** Small dark squares on bright patches: text on paper, keys on a keyboard,
   *  a socket on a white wall. They pass every shape test a marker does. */
  readonly specks?: number;
  /** Fraction of the frame width the code is offset from centre. */
  readonly offset?: number;
  /** Tilt away from the sensor plane, 0..1. A phone is never square-on. */
  readonly perspective?: number;
  /** In-plane rotation, degrees. */
  readonly rotate?: number;
  /** Box blur radius in pixels — defocus, motion, and the lens's own limit. */
  readonly blur?: number;
}

/**
 * A capture as a phone actually sees one: the code on a screen, a dark bezel
 * around it, a dim room beyond, and light falling off across the frame. The
 * `renderGrid` fixture is the opposite — a code filling a white field — which
 * is why loopback can be flawless while a camera is not.
 */
export function renderScene(grid: CellGrid, opts: SceneOptions = {}): RgbaImage {
  const width = opts.frameWidth ?? 960;
  const height = Math.round((width * 9) / 16);
  const fill = opts.fill ?? 0.5;
  const room = opts.room ?? 38;
  const gradient = opts.gradient ?? 0.35;
  const clutter = opts.clutter ?? 6;
  const rand = rng((opts.seed ?? 1) * 7919 + 13);

  // Render the code big enough that downscaling into the screen rectangle is
  // a reduction, matching a real display rather than an upscale.
  const screen = Math.round(width * fill);
  const scale = Math.max(2, Math.floor(screen / (grid.W + 8)));
  const code = renderGrid(grid, { ...opts, scale, margin: scale * 3 });

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    data[o] = room;
    data[o + 1] = room;
    data[o + 2] = room + 6; // rooms photograph slightly cool
    data[o + 3] = 255;
  }

  for (let i = 0; i < clutter; i++) {
    const cw = Math.round((0.04 + rand() * 0.1) * width);
    const ch = Math.round((0.04 + rand() * 0.1) * height);
    const cx = Math.round(rand() * (width - cw));
    const cy = Math.round(rand() * (height - ch));
    const level = Math.round(rand() * room);
    for (let y = cy; y < cy + ch; y++) {
      for (let x = cx; x < cx + cw; x++) {
        const o = (y * width + x) * 4;
        data[o] = level;
        data[o + 1] = level;
        data[o + 2] = level;
      }
    }
  }

  // Marker lookalikes: a small dark square inside a bright field passes every
  // shape and quiet-ring test a real corner marker does.
  for (let i = 0; i < (opts.specks ?? 0); i++) {
    const pad = Math.round((0.02 + rand() * 0.02) * width);
    const size = Math.max(4, Math.round((0.008 + rand() * 0.01) * width));
    const px = Math.round(rand() * (width - pad * 2 - size));
    const py = Math.round(rand() * (height - pad * 2 - size));
    const paper = 190 + Math.round(rand() * 50);
    for (let y = py; y < py + pad * 2 + size; y++) {
      for (let x = px; x < px + pad * 2 + size; x++) {
        const o = (y * width + x) * 4;
        const dark = y >= py + pad && y < py + pad + size && x >= px + pad && x < px + pad + size;
        const level = dark ? 20 + Math.round(rand() * 20) : paper;
        data[o] = level;
        data[o + 1] = level;
        data[o + 2] = level;
      }
    }
  }

  const ox = Math.round((width - code.width) / 2 + (opts.offset ?? 0) * width);
  const oy = Math.round((height - code.height) / 2);
  const tilt = (opts.perspective ?? 0) * code.height * 0.5;
  const theta = ((opts.rotate ?? 0) * Math.PI) / 180;

  const cx = ox + code.width / 2;
  const cy = oy + code.height / 2;
  const spin = (x: number, y: number) => {
    const dx = x - cx;
    const dy = y - cy;
    return {
      x: cx + dx * Math.cos(theta) - dy * Math.sin(theta),
      y: cy + dx * Math.sin(theta) + dy * Math.cos(theta),
    };
  };

  const quad = [
    spin(ox, oy + tilt),
    spin(ox + code.width, oy),
    spin(ox + code.width, oy + code.height),
    spin(ox, oy + code.height - tilt),
  ];

  // Destination -> source, so every pixel inside the quad gets a sample
  // rather than the holes a forward map would leave.
  const inv = homography(
    quad.map((p) => [p.x, p.y] as const),
    [
      { x: 0, y: 0 },
      { x: code.width, y: 0 },
      { x: code.width, y: code.height },
      { x: 0, y: code.height },
    ],
  );
  if (!inv) throw new Error("degenerate scene quad");

  const minX = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x))));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(...quad.map((p) => p.x))));
  const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...quad.map((p) => p.y))));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const [u, v] = applyHomography(inv, x + 0.5, y + 0.5);
      if (u < 0 || v < 0 || u >= code.width - 1 || v >= code.height - 1) continue;

      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = code.data[(y0 * code.width + x0) * 4 + c];
        const p10 = code.data[(y0 * code.width + x0 + 1) * 4 + c];
        const p01 = code.data[((y0 + 1) * code.width + x0) * 4 + c];
        const p11 = code.data[((y0 + 1) * code.width + x0 + 1) * 4 + c];
        data[o + c] =
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
      }
    }
  }

  const blur = Math.round(opts.blur ?? 0);
  if (blur > 0) boxBlur(data, width, height, blur);

  if (gradient > 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const t = (x / width + y / height) / 2;
        const gain = 1 - gradient * t;
        const o = (y * width + x) * 4;
        data[o] *= gain;
        data[o + 1] *= gain;
        data[o + 2] *= gain;
      }
    }
  }

  return { data, width, height };
}

function boxBlur(data: Uint8ClampedArray, width: number, height: number, radius: number): void {
  const src = Uint8ClampedArray.from(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const sy = y + dy;
          if (sy < 0 || sy >= height) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const sx = x + dx;
            if (sx < 0 || sx >= width) continue;
            sum += src[(sy * width + sx) * 4 + c];
            n++;
          }
        }
        data[(y * width + x) * 4 + c] = sum / n;
      }
    }
  }
}
