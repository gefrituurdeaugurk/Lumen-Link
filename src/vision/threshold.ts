/** Otsu's method: the threshold maximising between-class variance. */
export function otsu(gray: Uint8ClampedArray): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  let total = 0;
  for (let i = 0; i < 256; i++) total += i * hist[i];

  const n = gray.length;
  let sumBelow = 0;
  let weightBelow = 0;
  let best = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    weightBelow += hist[t];
    if (weightBelow === 0) continue;
    const weightAbove = n - weightBelow;
    if (weightAbove === 0) break;

    sumBelow += t * hist[t];
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (total - sumBelow) / weightAbove;
    const variance = weightBelow * weightAbove * (meanBelow - meanAbove) ** 2;
    if (variance > best) {
      best = variance;
      threshold = t;
    }
  }
  return threshold;
}
