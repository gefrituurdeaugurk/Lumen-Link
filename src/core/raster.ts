/**
 * Cell-grid rasterisation — where framed bits land on the grid.
 *
 * This is protocol, not presentation: it decides which cell carries which
 * bit. Mapping cells to actual colours belongs to the renderer.
 */

import { bandRow, NBANDS, type Geometry } from "./geometry.ts";
import type { BitPlane } from "./bits.ts";

/**
 * Two independent bit planes over the same cells. `luma` drives the
 * black/white axis, `blue` the blue/yellow axis. Palette index is
 * `luma + 2 * blue`.
 */
export interface CellGrid {
  readonly W: number;
  readonly luma: Uint8Array;
  readonly blue: Uint8Array;
}

/** Palette in wire order: [black, yellow, blue, white]. */
export const PALETTE: readonly (readonly [number, number, number])[] = [
  [11, 11, 15],
  [255, 229, 0],
  [27, 44, 255],
  [255, 255, 255],
];

export function createGrid(W: number): CellGrid {
  return { W, luma: new Uint8Array(W * W), blue: new Uint8Array(W * W) };
}

function fill(g: CellGrid, luma: number, blue: number): void {
  g.luma.fill(luma);
  g.blue.fill(blue);
}

function block(g: CellGrid, x0: number, y0: number, w: number, h: number, l: number, b: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      g.luma[y * g.W + x] = l;
      g.blue[y * g.W + x] = b;
    }
  }
}

/** Width of one calibration patch in cells. */
export function calibrationPatchWidth(W: number): number {
  return Math.floor((W - 18) / 4);
}

/**
 * Registration marks and the calibration strip. Three 6x6 markers plus one
 * 4x4 — the odd size keys rotation, so a receiver can resolve orientation
 * from marker area alone.
 */
export function drawQuietStructure(g: CellGrid): void {
  const W = g.W;
  fill(g, 1, 1); // quiet field is white

  block(g, 1, 1, 6, 6, 0, 0);
  block(g, W - 7, 1, 6, 6, 0, 0);
  block(g, 1, W - 7, 6, 6, 0, 0);
  block(g, W - 6, W - 6, 4, 4, 0, 0);

  // All four palette extremes, every frame, so white balance and the blue
  // axis are re-referenced per frame rather than assumed.
  const cw = calibrationPatchWidth(W);
  for (let k = 0; k < 4; k++) {
    block(g, 9 + k * cw, 1, cw, 6, k >> 1, k & 1);
  }
}

/** Lay a band's bit plane across its rows on the luma plane. */
export function writeLumaBand(g: CellGrid, geo: Geometry, band: number, bits: BitPlane): void {
  let p = 0;
  for (let r = 0; r < geo.bandH; r++) {
    const y = bandRow(geo, band) + r;
    for (let x = 0; x < g.W; x++) g.luma[y * g.W + x] = bits[p++];
  }
}

/**
 * Lay the enhancement layer across the blue plane at 2x2 cell pitch. The
 * coarser pitch buys chroma the spatial averaging it needs, since sensors
 * resolve the blue/yellow axis far worse than luminance.
 */
export function writeChromaPlane(g: CellGrid, geo: Geometry, bits: BitPlane): void {
  const bw = g.W >> 1;
  const bh = (g.W - 16) >> 1;
  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const v = bits[p++];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          g.blue[(8 + by * 2 + dy) * g.W + bx * 2 + dx] = v;
        }
      }
    }
  }
}

/** Force the blue plane on across the band region, collapsing the palette to
 *  pure black/white. Used when the enhancement layer is disabled. */
export function fillChromaPlane(g: CellGrid): void {
  for (let y = 8; y < g.W - 8; y++) {
    for (let x = 0; x < g.W; x++) g.blue[y * g.W + x] = 1;
  }
}

export { NBANDS };
