/**
 * Frame decoding: from captured pixels to framed bands.
 *
 * This layer knows nothing about sessions or fountain codes. It resolves
 * geometry, calibrates the two colour axes against the on-frame patches, and
 * hands up whatever bands survived their CRC. Deciding what those bands
 * *mean* is the session layer's job.
 */

import { CHROMA_BAND, unpackBand, type BandFrame } from "../core/framing.ts";
import { bandRow, NBANDS, type Geometry } from "../core/geometry.ts";
import { calibrationPatchWidth } from "../core/raster.ts";
import { applyHomography, homography, type Homography } from "./homography.ts";
import type { Blob } from "./markers.ts";
import type { RgbaImage } from "./image.ts";

/** Minimum blue-axis separation, in differential units, for the enhancement
 *  layer to be worth reading at all. */
export const CHROMA_FLOOR = 16;

/** Minimum luma gap between the black and yellow calibration patches before
 *  we believe we are looking at the grid the right way up. */
const LUMA_POLARITY_FLOOR = 18;

export interface FrameReadout {
  readonly frames: BandFrame[];
  readonly bandsTried: number;
  readonly bandsPassed: number;
  readonly chromaTried: number;
  readonly chromaPassed: number;
  /** Blue-axis separation measured from the calibration strip. */
  readonly separation: number;
  readonly homography: Homography;
  readonly rotation: number;
}

interface Sampled {
  readonly luma: Float32Array;
  readonly chroma: Float32Array;
}

/** Nearest-neighbour sample of one cell centre per grid cell. */
function sampleGrid(img: RgbaImage, h: Homography, geo: Geometry): Sampled | null {
  const { data, width, height } = img;
  const W = geo.W;
  const luma = new Float32Array(W * W);
  const chroma = new Float32Array(W * W);

  for (let cy = 0; cy < W; cy++) {
    for (let cx = 0; cx < W; cx++) {
      const [px, py] = applyHomography(h, cx + 0.5, cy + 0.5);
      const ix = Math.round(px);
      const iy = Math.round(py);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) return null;

      const o = (iy * width + ix) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      luma[cy * W + cx] = 0.299 * r + 0.587 * g + 0.114 * b;
      // Blue/yellow difference. Differential against the other two channels,
      // so it survives the overall gain shifts that auto-exposure applies.
      chroma[cy * W + cx] = b - (r + g) / 2;
    }
  }
  return { luma, chroma };
}

interface Calibration {
  readonly lumaThreshold: number;
  /** Blue-axis slice for dark cells: black against blue. */
  readonly chromaDarkThreshold: number;
  /** Blue-axis slice for bright cells: yellow against white. */
  readonly chromaBrightThreshold: number;
  /** Half-separation of each pair, used to normalise soft decisions. */
  readonly chromaDarkScale: number;
  readonly chromaBrightScale: number;
  /** Worst-case separation across the two pairs. */
  readonly separation: number;
  readonly plausible: boolean;
}

/**
 * Read the four palette extremes from the top strip.
 *
 * The blue axis needs two thresholds, not one. Black and white sit within a
 * few levels of each other on the blue/yellow difference yet carry opposite
 * blue bits, so a single slice across all four colours is unreadable no
 * matter how clean the capture. Conditioning on the luma bit turns it into
 * two well-separated binary decisions: black against blue for dark cells,
 * yellow against white for bright ones.
 */
function calibrate(s: Sampled, geo: Geometry): Calibration {
  const W = geo.W;
  const cw = calibrationPatchWidth(W);
  const refs: { luma: number; chroma: number }[] = [];

  for (let k = 0; k < 4; k++) {
    let sl = 0;
    let sc = 0;
    let n = 0;
    for (let y = 2; y < 6; y++) {
      for (let x = 9 + k * cw + 1; x < 9 + (k + 1) * cw - 1; x++) {
        sl += s.luma[y * W + x];
        sc += s.chroma[y * W + x];
        n++;
      }
    }
    refs.push({ luma: sl / n, chroma: sc / n });
  }

  // Patch order is black, blue, yellow, white.
  const [black, blue, yellow, white] = refs;
  const dark = (black.luma + blue.luma) / 2;
  const bright = (yellow.luma + white.luma) / 2;

  const darkGap = blue.chroma - black.chroma;
  const brightGap = white.chroma - yellow.chroma;

  return {
    lumaThreshold: (dark + bright) / 2,
    chromaDarkThreshold: (black.chroma + blue.chroma) / 2,
    chromaBrightThreshold: (yellow.chroma + white.chroma) / 2,
    chromaDarkScale: Math.max(1, Math.abs(darkGap) / 2),
    chromaBrightScale: Math.max(1, Math.abs(brightGap) / 2),
    // The layer is only as readable as its weaker pair, so report that
    // rather than the flattering average.
    separation: Math.min(Math.abs(darkGap), Math.abs(brightGap)),
    plausible: yellow.luma - black.luma >= LUMA_POLARITY_FLOOR,
  };
}

/**
 * Rotation implied by marker geometry: the 4x4 marker sits bottom-right in
 * canonical orientation, so whichever observed corner has the smallest area
 * tells us how the grid is turned.
 */
function rotationFromMarkers(corners: readonly Blob[]): number {
  let smallest = 0;
  for (let i = 1; i < 4; i++) if (corners[i].area < corners[smallest].area) smallest = i;
  return (smallest - 2 + 4) % 4;
}

export class FrameDecoder {
  /** Last rotation that produced a passing CRC; tried first next time. */
  private rotationHint: number | null = null;
  private readonly geometry: Geometry;

  constructor(geometry: Geometry) {
    this.geometry = geometry;
  }

  decode(img: RgbaImage, corners: readonly Blob[]): FrameReadout | null {
    const geo = this.geometry;

    const candidates: number[] = [];
    const push = (r: number) => {
      if (!candidates.includes(r)) candidates.push(r);
    };
    if (this.rotationHint !== null) push(this.rotationHint);
    push(rotationFromMarkers(corners));
    for (let r = 0; r < 4; r++) push(r);

    for (let ci = 0; ci < candidates.length; ci++) {
      const rotation = candidates[ci];
      const dst = [0, 1, 2, 3].map((i) => corners[(i + rotation) % 4]);
      const h = homography(geo.corners, dst);
      if (!h) continue;

      const sampled = sampleGrid(img, h, geo);
      if (!sampled) continue;

      const cal = calibrate(sampled, geo);
      if (!cal.plausible) continue;

      const frames: BandFrame[] = [];
      let bandsPassed = 0;

      for (let band = 0; band < NBANDS; band++) {
        const bits = new Uint8Array(geo.bandCapacity);
        let p = 0;
        for (let r = 0; r < geo.bandH; r++) {
          const y = bandRow(geo, band) + r;
          for (let x = 0; x < geo.W; x++) {
            bits[p++] = sampled.luma[y * geo.W + x] > cal.lumaThreshold ? 1 : 0;
          }
        }
        const frame = unpackBand(bits, band, geo.symBytes);
        // The header's band field must agree with where we read it from;
        // a mismatch means we resolved geometry wrong despite a CRC pass.
        if (frame && frame.band === band) {
          bandsPassed++;
          frames.push(frame);
        }
      }

      // Nothing read: almost certainly the wrong orientation, so try the next
      // candidate rather than reporting a locked frame with no content.
      if (bandsPassed === 0 && ci < candidates.length - 1) continue;
      this.rotationHint = bandsPassed > 0 ? rotation : this.rotationHint;

      let chromaTried = 0;
      let chromaPassed = 0;
      if (cal.separation > CHROMA_FLOOR) {
        chromaTried = 1;
        const frame = this.readChroma(sampled, cal);
        if (frame) {
          chromaPassed = 1;
          frames.push(frame);
        }
      }

      return {
        frames,
        bandsTried: NBANDS,
        bandsPassed,
        chromaTried,
        chromaPassed,
        separation: cal.separation,
        homography: h,
        rotation,
      };
    }
    return null;
  }

  /**
   * Read the blue plane at 2x2 pitch.
   *
   * Each cell is sliced against the threshold for its own luma class, and the
   * four normalised margins are summed before the decision. Combining soft
   * margins rather than hard votes avoids ties and keeps the extra spatial
   * averaging that the coarse pitch is there to buy.
   */
  private readChroma(s: Sampled, cal: Calibration): BandFrame | null {
    const geo = this.geometry;
    const W = geo.W;
    const bw = W >> 1;
    const bh = (W - 16) >> 1;
    const bits = new Uint8Array(geo.chromaCapacity);
    let p = 0;

    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let margin = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = (8 + by * 2 + dy) * W + bx * 2 + dx;
            const bright = s.luma[i] > cal.lumaThreshold;
            const threshold = bright ? cal.chromaBrightThreshold : cal.chromaDarkThreshold;
            const scale = bright ? cal.chromaBrightScale : cal.chromaDarkScale;
            margin += (s.chroma[i] - threshold) / scale;
          }
        }
        bits[p++] = margin > 0 ? 1 : 0;
      }
    }

    const frame = unpackBand(bits, CHROMA_BAND, geo.symBytes);
    return frame && frame.band === CHROMA_BAND ? frame : null;
  }
}
