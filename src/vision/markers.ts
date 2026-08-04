/**
 * Registration-marker detection: connected dark components filtered down to
 * things that look like the four square markers, then sorted into corner
 * order.
 */

export interface Blob {
  readonly x: number;
  readonly y: number;
  /** Pixel area — the 4x4 marker is smaller than the three 6x6 ones, which
   *  is what keys grid rotation. */
  readonly area: number;
}

const MIN_AREA = 16;
const MAX_AREA_FRACTION = 0.05;
const MAX_EXTENT_FRACTION = 0.35;
const MIN_ASPECT = 0.55;
const MAX_ASPECT = 1.8;
const MIN_FILL = 0.58;

/** Pixels outside the bounding box to sample for the quiet ring. Deliberately
 *  small: the markers are separated from the grid edge by a single white
 *  cell, so a wide ring would run off the code and into the backdrop. */
const RING_PAD = 2;
/** Fraction of ring samples that must be bright to accept a blob. */
const MIN_RING_BRIGHT = 0.75;

/**
 * Markers sit in the white quiet field; band cells sit among other band
 * cells. Requiring a bright ring is what separates the two, and without it
 * an isolated dark cell in the band region is indistinguishable from a
 * marker on area and shape alone.
 */
function hasQuietRing(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const x0 = minX - RING_PAD;
  const x1 = maxX + RING_PAD;
  const y0 = minY - RING_PAD;
  const y1 = maxY + RING_PAD;

  let bright = 0;
  let sampled = 0;
  const test = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    sampled++;
    if (gray[y * w + x] >= threshold) bright++;
  };

  for (let x = x0; x <= x1; x++) {
    test(x, y0);
    test(x, y1);
  }
  for (let y = y0 + 1; y < y1; y++) {
    test(x0, y);
    test(x1, y);
  }

  // Too few valid samples means the blob is against the frame edge; accept
  // rather than reject, and let the CRC settle it downstream.
  if (sampled < 8) return true;
  return bright / sampled >= MIN_RING_BRIGHT;
}

/** Flood-fill dark regions and keep the square-ish, plausibly sized ones. */
export function findMarkerBlobs(
  gray: Uint8ClampedArray,
  w: number,
  h: number,
  threshold: number,
): Blob[] {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Blob[] = [];
  let label = 0;

  for (let seed = 0; seed < w * h; seed++) {
    if (gray[seed] >= threshold || labels[seed]) continue;
    label++;

    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = label;

    let area = 0;
    let sx = 0;
    let sy = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;

    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p / w) | 0;
      area++;
      sx += px;
      sy += py;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      if (px > 0 && !labels[p - 1] && gray[p - 1] < threshold) {
        labels[p - 1] = label;
        stack[sp++] = p - 1;
      }
      if (px < w - 1 && !labels[p + 1] && gray[p + 1] < threshold) {
        labels[p + 1] = label;
        stack[sp++] = p + 1;
      }
      if (py > 0 && !labels[p - w] && gray[p - w] < threshold) {
        labels[p - w] = label;
        stack[sp++] = p - w;
      }
      if (py < h - 1 && !labels[p + w] && gray[p + w] < threshold) {
        labels[p + w] = label;
        stack[sp++] = p + w;
      }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (area < MIN_AREA || area > w * h * MAX_AREA_FRACTION) continue;
    if (bw < 3 || bh < 3 || bw > w * MAX_EXTENT_FRACTION || bh > h * MAX_EXTENT_FRACTION) continue;
    const aspect = bw / bh;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
    if (area / (bw * bh) < MIN_FILL) continue;
    if (!hasQuietRing(gray, w, h, threshold, minX, minY, maxX, maxY)) continue;

    out.push({ x: sx / area, y: sy / area, area });
  }
  return out;
}

/**
 * Pick four extremal blobs as TL, TR, BR, BL. Extremes of x+y and x-y are
 * cheap and robust to moderate perspective; heavy skew is handled by trying
 * rotations against the CRC downstream.
 */
export function orderCorners(blobs: readonly Blob[]): Blob[] | null {
  if (blobs.length < 4) return null;

  let tl = 0;
  let br = 0;
  let tr = 0;
  let bl = 0;
  for (let i = 1; i < blobs.length; i++) {
    const b = blobs[i];
    if (b.x + b.y < blobs[tl].x + blobs[tl].y) tl = i;
    if (b.x + b.y > blobs[br].x + blobs[br].y) br = i;
    if (b.x - b.y > blobs[tr].x - blobs[tr].y) tr = i;
    if (b.x - b.y < blobs[bl].x - blobs[bl].y) bl = i;
  }

  const idx = [tl, tr, br, bl];
  if (new Set(idx).size < 4) return null;
  return idx.map((i) => blobs[i]);
}
