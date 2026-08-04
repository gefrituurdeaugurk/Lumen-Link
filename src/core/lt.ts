/**
 * LT fountain code (Luby transform) with a robust soliton degree
 * distribution.
 *
 * The property the whole system rests on: a symbol's composition is derived
 * from its ESI alone, so encoder and decoder agree with no back channel, and
 * any K(1+e) distinct symbols reconstruct the payload regardless of *which*
 * ones arrived.
 */

import { mulberry32 } from "./rng.ts";
import { xorInto } from "./bits.ts";
import { crc32 } from "./crc.ts";

/** ESI is a 16-bit field on the wire; a session offers at most this many
 *  distinct symbols before the space repeats. See SPEC.md §7. */
export const ESI_SPACE = 1 << 16;

/** Upper bound on source blocks per session, so that ESI_SPACE always leaves
 *  generous fountain overhead (>=8x K). See SPEC.md §7. */
export const MAX_K = 8192;

const DELTA = 0.05;
const C = 0.03;

/** Cumulative robust soliton distribution over degrees 1..K. */
export function solitonCDF(K: number): Float64Array {
  const R = Math.max(1, C * Math.log(K / DELTA) * Math.sqrt(K));
  const w = new Float64Array(K + 1);
  w[1] = 1 / K;
  for (let d = 2; d <= K; d++) w[d] = 1 / (d * (d - 1));

  const pivot = Math.max(1, Math.round(K / R));
  for (let d = 1; d < pivot && d <= K; d++) w[d] += R / (d * K);
  if (pivot <= K) w[pivot] += (R * Math.log(R / DELTA)) / K;

  let total = 0;
  for (let d = 1; d <= K; d++) total += w[d];

  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += w[d] / total;
    cdf[d] = acc;
  }
  return cdf;
}

function pickDegree(cdf: Float64Array, K: number, u: number): number {
  for (let d = 1; d <= K; d++) if (u <= cdf[d]) return d;
  return K;
}

/**
 * Source-block indices composing symbol `esi`. Deterministic from the ESI —
 * this is the function both ends must agree on bit-for-bit.
 */
export function symbolBlocks(esi: number, K: number, cdf: Float64Array): number[] {
  const rand = mulberry32(Math.imul(esi + 1, 2654435761) >>> 0);
  const degree = Math.min(K, pickDegree(cdf, K, rand()));
  const picked = new Set<number>();
  let guard = 0;
  while (picked.size < degree && guard++ < K * 20) {
    picked.add(Math.floor(rand() * K) % K);
  }
  return [...picked];
}

export interface Symbol {
  readonly esi: number;
  readonly data: Uint8Array;
}

export class LTEncoder {
  readonly K: number;
  readonly total: number;
  readonly fileCRC: number;
  readonly symBytes: number;

  private readonly blocks: Uint8Array[] = [];
  private readonly cdf: Float64Array;
  private counter = 0;

  constructor(payload: Uint8Array, symBytes: number) {
    this.symBytes = symBytes;
    this.total = payload.length;
    this.K = Math.max(1, Math.ceil(payload.length / symBytes));
    if (this.K > MAX_K) {
      throw new RangeError(
        `payload needs K=${this.K} source blocks, over the ${MAX_K} ceiling; ` +
          `segment it across sessions (SPEC.md §7)`,
      );
    }
    for (let i = 0; i < this.K; i++) {
      const b = new Uint8Array(symBytes);
      b.set(payload.subarray(i * symBytes, Math.min(payload.length, (i + 1) * symBytes)));
      this.blocks.push(b);
    }
    this.cdf = solitonCDF(this.K);
    this.fileCRC = crc32(payload);
  }

  /** Distinct symbols emitted so far. */
  get emitted(): number {
    return this.counter;
  }

  /** True once the ESI space has been exhausted and symbols start repeating. */
  get exhausted(): boolean {
    return this.counter >= ESI_SPACE;
  }

  next(): Symbol {
    const esi = this.counter++ % ESI_SPACE;
    const data = new Uint8Array(this.symBytes);
    for (const i of symbolBlocks(esi, this.K, this.cdf)) xorInto(data, this.blocks[i]);
    return { esi, data };
  }
}

export class LTDecoder {
  readonly K: number;
  readonly symBytes: number;
  readonly total: number;
  readonly fileCRC: number;

  private readonly blocks: (Uint8Array | null)[];
  private readonly cdf: Float64Array;
  private readonly seen = new Set<number>();
  private pending: { data: Uint8Array; remaining: number[] }[] = [];
  private recovered = 0;

  constructor(K: number, symBytes: number, total: number, fileCRC: number) {
    this.K = K;
    this.symBytes = symBytes;
    this.total = total;
    this.fileCRC = fileCRC;
    this.blocks = new Array<Uint8Array | null>(K).fill(null);
    this.cdf = solitonCDF(K);
  }

  get have(): number {
    return this.recovered;
  }

  get complete(): boolean {
    return this.recovered === this.K;
  }

  /** Distinct ESIs consumed. Once this reaches ESI_SPACE the fountain has
   *  nothing new to offer and a stalled session must be abandoned. */
  get distinctSeen(): number {
    return this.seen.size;
  }

  get exhausted(): boolean {
    return !this.complete && this.seen.size >= ESI_SPACE;
  }

  /** @returns true if the symbol was new and was absorbed. */
  add(esi: number, data: Uint8Array): boolean {
    if (this.complete || this.seen.has(esi)) return false;
    this.seen.add(esi);

    const residual = data.slice();
    const remaining: number[] = [];
    for (const i of symbolBlocks(esi, this.K, this.cdf)) {
      const known = this.blocks[i];
      if (known) xorInto(residual, known);
      else remaining.push(i);
    }
    this.pending.push({ data: residual, remaining });
    this.peel();
    return true;
  }

  private peel(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const s of this.pending) {
        if (s.remaining.length !== 1) continue;
        const i = s.remaining[0];
        if (this.blocks[i]) continue;

        this.blocks[i] = s.data.slice();
        this.recovered++;
        progressed = true;

        for (const other of this.pending) {
          const at = other.remaining.indexOf(i);
          if (at >= 0) {
            xorInto(other.data, this.blocks[i]!);
            other.remaining.splice(at, 1);
          }
        }
      }
      if (progressed) this.pending = this.pending.filter((s) => s.remaining.length > 0);
    }
  }

  /** Reassemble the payload. Recovered blocks only; gaps read as zeros. */
  assemble(): Uint8Array {
    const out = new Uint8Array(this.K * this.symBytes);
    for (let i = 0; i < this.K; i++) {
      const b = this.blocks[i];
      if (b) out.set(b, i * this.symBytes);
    }
    return out.subarray(0, this.total);
  }

  /** Reassemble and check against the manifest's whole-file CRC. */
  verify(): { bytes: Uint8Array; ok: boolean } {
    const bytes = this.assemble();
    return { bytes, ok: this.complete && crc32(bytes) === this.fileCRC };
  }
}
