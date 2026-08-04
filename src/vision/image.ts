/**
 * A DOM-free stand-in for `ImageData`. The vision pipeline only ever needs
 * RGBA bytes plus dimensions, so taking this instead of `ImageData` keeps it
 * runnable under Node and testable without a canvas.
 */
export interface RgbaImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Rec.601 luma, integer approximation. */
export function toGrayscale(img: RgbaImage): Uint8ClampedArray {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0; i < out.length; i++) {
    out[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
  }
  return out;
}
