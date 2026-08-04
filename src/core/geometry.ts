/**
 * Grid geometry.
 *
 * A frame is a W x W cell grid:
 *   rows 0..7          top zone: TL marker, calibration strip, TR marker
 *   rows 8..W-9        band region, NBANDS bands of (W-16)/NBANDS rows
 *   rows W-8..W-1      bottom zone: BL marker, BR marker (smaller, keys rotation)
 *
 * Each cell carries two independent bits: luma (black/white axis) and blue
 * (blue/yellow axis). The luma plane carries NBANDS band symbols; the blue
 * plane carries one further symbol at 2x2 cell pitch across the band region.
 */

import { HEADER_BITS, CRC_BITS } from "./framing.ts";

export const NBANDS = 4;

/** Grid sizes the format defines calibration and marker placement for. */
export const STANDARD_GRIDS = [48, 64, 80] as const;
export type StandardGrid = (typeof STANDARD_GRIDS)[number];

export interface Geometry {
  /** Cells per side. */
  readonly W: number;
  /** Rows per luma band. */
  readonly bandH: number;
  /** Bits carried by one luma band. */
  readonly bandCapacity: number;
  /** Bits carried by the blue plane across the whole band region. */
  readonly chromaCapacity: number;
  /** Payload bytes per symbol, common to every band and to the blue plane. */
  readonly symBytes: number;
  /** Marker centres in cell coordinates, ordered TL, TR, BR, BL. */
  readonly corners: readonly (readonly [number, number])[];
}

export function geometry(W: number): Geometry {
  if (W % 16 !== 0) throw new RangeError(`grid ${W} must be a multiple of 16`);
  const bandH = (W - 16) / NBANDS;
  const bandCapacity = W * bandH;
  const chromaCapacity = (W >> 1) * ((W - 16) >> 1);

  // Every band and the blue plane carry the same symbol size, so the smaller
  // of the two capacities sets it. Round down to a whole number of 8-byte
  // words to keep symbols cheap to XOR.
  const usable = Math.min(bandCapacity, chromaCapacity) - HEADER_BITS - CRC_BITS;
  const symBytes = Math.max(8, (Math.floor(usable / 8) >> 3) << 3);

  return {
    W,
    bandH,
    bandCapacity,
    chromaCapacity,
    symBytes,
    corners: [
      [4, 4],
      [W - 4, 4],
      [W - 4, W - 4],
      [4, W - 4],
    ],
  };
}

/** First grid row of luma band `band`. */
export function bandRow(g: Geometry, band: number): number {
  return 8 + band * g.bandH;
}
