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
 * Bounds on a candidate quad, all scale-free so they hold at any distance.
 *
 * The four markers sit on the corners of a square, so a real capture of one
 * is a convex, roughly square quadrilateral whose corner blobs are of similar
 * size and are small relative to the quad they span. Every one of these is
 * cheap, and together they are what separates the code from the dark specks a
 * room is full of.
 */
const MAX_SIDE_RATIO = 2.6;
const MAX_DIAGONAL_RATIO = 1.9;
const MIN_SIDE_PX = 12;
/** Quad area against the square of its mean side: rejects slivers. */
const MIN_SQUARENESS = 0.4;
/** Spread of blob areas within one quad. The 4x4 marker against a 6x6 is
 *  2.25x before perspective is allowed for. */
const AREA_SPREAD = 4.5;
/** Marker side as a fraction of the quad's side. A 48x48 grid gives about
 *  0.14, a 96x96 about 0.06; specks scattered across a room give far less. */
const MIN_MARKER_RATIO = 0.035;
const MAX_MARKER_RATIO = 0.45;
/** How far the observed marker ratio may stray from the expected one, as a
 *  log factor. ln(2) accepts anything within a factor of two. */
const MAX_RATIO_DRIFT = Math.LN2;
/** Blobs considered together at one area scale. Bounds the subset search. */
const MAX_WINDOW = 22;
/** Blobs kept before searching, largest first. A code held up to a camera has
 *  markers among the biggest things that survive the quiet-ring test, and the
 *  search is cubic in whatever is left. */
const MAX_BLOBS = 18;

const dist = (a: Blob, b: Blob): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Mean marker side over the distance between marker centres, in cells.
 *
 * Three 6x6 markers and one 4x4 sit four cells in from each edge, so this is
 * fixed by the format and independent of distance, rotation and scale. It is
 * the sharpest single test there is for telling the code apart from anything
 * else dark in the frame.
 */
export function expectedMarkerRatio(W: number): number {
  return Math.sqrt((36 + 36 + 36 + 16) / 4) / (W - 8);
}

/** Convex order starting at the top-left corner, matching the canonical
 *  corner list: TL, TR, BR, BL. Null if the four points are not convex. */
function orderQuad(quad: readonly Blob[]): Blob[] | null {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

  // y grows downward, so ascending angle walks the hull clockwise.
  const ring = [...quad].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );

  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % 4];
    const c = ring[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross <= 0) return null;
  }

  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (ring[i].x + ring[i].y < ring[start].x + ring[start].y) start = i;
  }
  return [0, 1, 2, 3].map((i) => ring[(start + i) % 4]);
}

/** Higher is better; null rejects the quad outright. */
function scoreQuad(p: readonly Blob[], expected: number | undefined): number | null {
  const sides = [dist(p[0], p[1]), dist(p[1], p[2]), dist(p[2], p[3]), dist(p[3], p[0])];
  const minSide = Math.min(...sides);
  const maxSide = Math.max(...sides);
  if (minSide < MIN_SIDE_PX) return null;
  if (maxSide / minSide > MAX_SIDE_RATIO) return null;

  const d0 = dist(p[0], p[2]);
  const d1 = dist(p[1], p[3]);
  if (Math.max(d0, d1) / Math.min(d0, d1) > MAX_DIAGONAL_RATIO) return null;

  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;

  const meanSide = (sides[0] + sides[1] + sides[2] + sides[3]) / 4;
  if (area < MIN_SQUARENESS * meanSide * meanSide) return null;

  const areas = p.map((b) => b.area);
  if (Math.max(...areas) / Math.min(...areas) > AREA_SPREAD) return null;

  const markerSide = Math.sqrt(areas.reduce((s, a) => s + a, 0) / 4);
  const ratio = markerSide / meanSide;
  if (ratio < MIN_MARKER_RATIO || ratio > MAX_MARKER_RATIO) return null;

  const skew = (maxSide / minSide) * (Math.max(d0, d1) / Math.min(d0, d1));
  if (expected === undefined) {
    // Without a grid size to compare against, prefer the largest plausible
    // quad: the code is the thing held up to the camera.
    return area / skew;
  }

  const drift = Math.abs(Math.log(ratio / expected));
  if (drift > MAX_RATIO_DRIFT) return null;
  return 1 / ((1 + drift) * skew);
}

/**
 * Candidate marker quads, best first.
 *
 * More than one is offered because no purely geometric test can be certain:
 * the CRC downstream is the only authority on whether a quad was the code, so
 * the caller tries them in order until a band reads.
 */
export function findMarkerQuads(
  blobs: readonly Blob[],
  limit = 4,
  expected?: number,
): Blob[][] {
  if (blobs.length < 4) return [];

  // Anchor each subset at its smallest member and only look at blobs within
  // one area scale of it: the four markers are near enough the same size, so
  // this prunes almost everything without ever splitting a real set.
  const kept =
    blobs.length <= MAX_BLOBS
      ? [...blobs]
      : [...blobs].sort((a, b) => b.area - a.area).slice(0, MAX_BLOBS);
  const sorted = kept.sort((a, b) => a.area - b.area);
  const found: { quad: Blob[]; score: number }[] = [];

  for (let i = 0; i < sorted.length - 3; i++) {
    let end = i + 1;
    while (end < sorted.length && sorted[end].area <= sorted[i].area * AREA_SPREAD) end++;
    end = Math.min(end, i + 1 + MAX_WINDOW);

    for (let a = i + 1; a < end - 2; a++) {
      for (let b = a + 1; b < end - 1; b++) {
        for (let c = b + 1; c < end; c++) {
          const quad = orderQuad([sorted[i], sorted[a], sorted[b], sorted[c]]);
          if (!quad) continue;
          const score = scoreQuad(quad, expected);
          if (score !== null) found.push({ quad, score });
        }
      }
    }
  }

  found.sort((x, y) => y.score - x.score);
  return found.slice(0, limit).map((f) => f.quad);
}

/** The single most likely marker quad as TL, TR, BR, BL. */
export function orderCorners(blobs: readonly Blob[]): Blob[] | null {
  return findMarkerQuads(blobs, 1)[0] ?? null;
}
