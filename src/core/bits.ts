/**
 * Bit-plane helpers.
 *
 * The optical layer addresses one *cell* per bit, so a band is carried as a
 * `Uint8Array` with one element per bit (each 0 or 1) rather than packed
 * bytes. These helpers move between that representation and byte buffers.
 */

/** One element per bit, each 0 or 1. */
export type BitPlane = Uint8Array;

export class BitWriter {
  readonly bits: BitPlane;
  private p = 0;

  constructor(capacity: number) {
    this.bits = new Uint8Array(capacity);
  }

  get position(): number {
    return this.p;
  }

  get remaining(): number {
    return this.bits.length - this.p;
  }

  /** Write the low `width` bits of `value`, most significant first. */
  writeBits(value: number, width: number): void {
    if (this.p + width > this.bits.length) throw new RangeError("bit overflow");
    for (let i = width - 1; i >= 0; i--) this.bits[this.p++] = (value >>> i) & 1;
  }

  writeBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.writeBits(bytes[i], 8);
  }

  /** Fill the remainder from `fill`. Keeps the field visually busy so that
   *  thresholding still sees both palette extremes in a sparse frame. */
  padWith(fill: () => number): void {
    while (this.p < this.bits.length) this.bits[this.p++] = fill() < 0.5 ? 0 : 1;
  }
}

export class BitReader {
  private p = 0;
  private readonly bits: BitPlane;

  constructor(bits: BitPlane) {
    this.bits = bits;
  }

  get position(): number {
    return this.p;
  }

  seek(bit: number): void {
    this.p = bit;
  }

  readBits(width: number): number {
    let v = 0;
    for (let i = 0; i < width; i++) v = ((v << 1) | this.bits[this.p++]) >>> 0;
    return v >>> 0;
  }

  readBytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count * 8; i++) {
      if (this.bits[this.p++]) out[i >> 3] |= 128 >> (i & 7);
    }
    return out;
  }
}

/** In-place XOR of `src` into `dst`. Both must be the same length. */
export function xorInto(dst: Uint8Array, src: Uint8Array): void {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

export function writeU32BE(out: Uint8Array, offset: number, v: number): void {
  out[offset] = (v >>> 24) & 0xff;
  out[offset + 1] = (v >>> 16) & 0xff;
  out[offset + 2] = (v >>> 8) & 0xff;
  out[offset + 3] = v & 0xff;
}

export function readU32BE(b: Uint8Array, offset: number): number {
  return (
    ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0
  );
}

export function writeU16BE(out: Uint8Array, offset: number, v: number): void {
  out[offset] = (v >>> 8) & 0xff;
  out[offset + 1] = v & 0xff;
}

export function readU16BE(b: Uint8Array, offset: number): number {
  return ((b[offset] << 8) | b[offset + 1]) >>> 0;
}
