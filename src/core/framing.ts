/**
 * Band framing: the bits that wrap one fountain symbol into one readable
 * region of the grid.
 *
 * Wire layout of a band, in cell order:
 *
 *   [ header x3 ][ payload ][ crc32 ][ pad ]
 *      96 bits    8*S bits   32 bits
 *
 * The 4-byte header is repeated three times and recovered by majority vote,
 * because a rolling-shutter tear or a specular highlight tends to take out a
 * contiguous run of cells rather than scattered ones.
 *
 *   byte 0   type:4 | band:4
 *   byte 1   esi high byte
 *   byte 2   esi low byte
 *   byte 3   sid8 — low 8 bits of the session id (SPEC.md §4)
 *
 * The whole plane is then whitened against a band-keyed mask so that a
 * low-entropy payload cannot produce visible structure or a duty cycle far
 * from 50%. The mask is keyed by band index alone, which the receiver knows
 * from the region it is reading, so un-whitening needs no prior header parse.
 */

import { BitReader, BitWriter, type BitPlane } from "./bits.ts";
import { crc32Concat } from "./crc.ts";
import { mulberry32 } from "./rng.ts";

export const HEADER_BYTES = 4;
export const HEADER_REPEATS = 3;
export const HEADER_BITS = HEADER_BYTES * 8 * HEADER_REPEATS;
export const CRC_BITS = 32;

/** Band id reserved for the blue-plane enhancement layer. */
export const CHROMA_BAND = 8;

export const FrameType = {
  /** A fountain symbol. */
  Data: 0,
  /** An uncoded session manifest. */
  Manifest: 1,
  /** Advisory notice that the fountain is about to stop. */
  Close: 2,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface BandFrame {
  readonly type: number;
  readonly band: number;
  readonly esi: number;
  readonly sid8: number;
  readonly payload: Uint8Array;
}

const MASK_CACHE = new Map<string, BitPlane>();

/** Deterministic whitening mask for a band region of `capacity` bits. */
export function whiteningMask(band: number, capacity: number): BitPlane {
  const key = `${band}:${capacity}`;
  const hit = MASK_CACHE.get(key);
  if (hit) return hit;

  const rand = mulberry32(Math.imul(band + 0x9e37, 0x85ebca6b) >>> 0);
  const mask = new Uint8Array(capacity);
  for (let i = 0; i < capacity; i++) mask[i] = rand() < 0.5 ? 0 : 1;
  MASK_CACHE.set(key, mask);
  return mask;
}

function applyWhitening(bits: BitPlane, band: number): void {
  const mask = whiteningMask(band, bits.length);
  for (let i = 0; i < bits.length; i++) bits[i] ^= mask[i];
}

/** Bits a band must carry to hold a `symBytes` payload. */
export function bandBitsNeeded(symBytes: number): number {
  return HEADER_BITS + symBytes * 8 + CRC_BITS;
}

export function packBand(
  type: number,
  band: number,
  esi: number,
  sid8: number,
  payload: Uint8Array,
  capacity: number,
): BitPlane {
  if (bandBitsNeeded(payload.length) > capacity) {
    throw new RangeError(`payload of ${payload.length}B does not fit in ${capacity} bits`);
  }

  const header = new Uint8Array(HEADER_BYTES);
  header[0] = ((type & 0x0f) << 4) | (band & 0x0f);
  header[1] = (esi >>> 8) & 0xff;
  header[2] = esi & 0xff;
  header[3] = sid8 & 0xff;

  const w = new BitWriter(capacity);
  for (let r = 0; r < HEADER_REPEATS; r++) w.writeBytes(header);
  w.writeBytes(payload);
  w.writeBits(crc32Concat(header, payload), 32);

  // Only reached on non-standard grids; the three standard sizes pack exactly.
  if (w.remaining > 0) {
    const rand = mulberry32((Math.imul(esi + 1, 0x27d4eb2d) ^ band) >>> 0);
    w.padWith(rand);
  }

  applyWhitening(w.bits, band);
  return w.bits;
}

/**
 * Recover a band. Returns null when the CRC rejects it — which is the common
 * case for a torn or misaligned read, and is exactly what makes it safe to
 * try several orientations against the same frame.
 */
export function unpackBand(bits: BitPlane, band: number, symBytes: number): BandFrame | null {
  if (bits.length < bandBitsNeeded(symBytes)) return null;

  const plane = bits.slice();
  applyWhitening(plane, band);

  const header = new Uint8Array(HEADER_BYTES);
  const headerBits = HEADER_BYTES * 8;
  for (let i = 0; i < headerBits; i++) {
    let votes = 0;
    for (let r = 0; r < HEADER_REPEATS; r++) votes += plane[i + r * headerBits];
    if (votes * 2 > HEADER_REPEATS) header[i >> 3] |= 128 >> (i & 7);
  }

  const reader = new BitReader(plane);
  reader.seek(HEADER_BITS);
  const payload = reader.readBytes(symBytes);
  const checksum = reader.readBits(32);

  if (crc32Concat(header, payload) !== checksum) return null;

  return {
    type: header[0] >> 4,
    band: header[0] & 0x0f,
    esi: ((header[1] << 8) | header[2]) >>> 0,
    sid8: header[3],
    payload,
  };
}
