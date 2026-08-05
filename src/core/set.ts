/**
 * Segmenting payloads too large for one session (SPEC.md §5.4, §7).
 *
 * `esi` is 16 bits, so a session offers 65 536 distinct symbols and `K` is
 * capped at 8192 to keep 8x fountain overhead against it. Anything larger is
 * carried as a set of objects, each its own session, reassembled by
 * `objIndex`.
 *
 * Segments are transmitted round-robin rather than in order. There is no back
 * channel, so the transmitter cannot know which segment a given receiver still
 * needs; rotating gives every receiver a share of all of them, and the
 * fountain makes the interleaving free — a segment resumes where it left off
 * on the next pass.
 */

import { crc32 } from "./crc.ts";
import { geometry, NBANDS } from "./geometry.ts";
import { MAX_K } from "./lt.ts";
import type { EncryptionInfo, Manifest } from "./manifest.ts";
import type { CellGrid } from "./raster.ts";
import { assignNonces } from "./session.ts";
import { MANIFEST_INTERVAL, Transmitter, type FrameStats } from "./transmitter.ts";

/** Symbols a segment emits past its own K before the next one gets the
 *  screen. A receiver loses some to CRC, so a bare 1.0 would guarantee that
 *  nobody ever finishes a segment in one visit. */
const DWELL_OVERSHOOT = 1.4;
/** Floor for tiny segments, so rotation stays visible rather than flickering. */
const MIN_DWELL_FRAMES = 30;

/** Objects in one set. Bounded by the 8-bit short id: every segment needs a
 *  distinct one, or the router binds a symbol to the wrong decoder. */
export const MAX_SEGMENTS = 256;

/**
 * Frames to hold one segment on screen.
 *
 * Rotating on a fixed count is wrong at any real size: at 64x64 a full
 * segment is K = 8192 blocks against fewer than five symbols a frame, so a
 * hundred-frame slot delivers about six per cent of it and neither segment
 * ever converges until a dozen passes have gone by. Sizing the slot to the
 * segment lets a receiver watching from the start finish it in one visit.
 */
export function dwellFrames(K: number, enhancement: boolean): number {
  const perFrame = NBANDS - 1 / MANIFEST_INTERVAL + (enhancement ? 1 : 0);
  return Math.max(MIN_DWELL_FRAMES, Math.ceil((K * DWELL_OVERSHOOT) / perFrame));
}

/** Largest payload a single session can carry on this grid. */
export function segmentCapacity(grid: number): number {
  return geometry(grid).symBytes * MAX_K;
}

export function segmentPayload(payload: Uint8Array, segmentBytes: number): Uint8Array[] {
  if (segmentBytes <= 0) throw new RangeError("segmentBytes must be positive");
  if (payload.length <= segmentBytes) return [payload];

  const out: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += segmentBytes) {
    out.push(payload.subarray(off, Math.min(payload.length, off + segmentBytes)));
  }
  return out;
}

export interface SetTransmitterOptions {
  readonly grid: number;
  readonly name?: string;
  readonly enhancement?: boolean;
  readonly contentType?: string;
  readonly framesPerSegment?: number;
  /** Same contract as the single-session transmitter: the payload is already
   *  sealed, and `name` must be omitted because it lives inside the envelope. */
  readonly encryption?: EncryptionInfo;
  /** Cut smaller than the session ceiling. Shorter segments finish sooner and
   *  survive a receiver walking away mid-object. */
  readonly segmentBytes?: number;
}

export class SetTransmitter {
  /** CRC of the whole payload. Doubles as the set id, so a receiver can
   *  verify the reassembled file without a field the format does not have. */
  readonly setId: number;
  readonly segments: readonly Transmitter[];
  /** Frames each segment holds the screen for. */
  readonly dwell: readonly number[];
  readonly total: number;

  private index = 0;
  private framesOnSegment = 0;

  constructor(payload: Uint8Array, opts: SetTransmitterOptions) {
    this.setId = crc32(payload);
    this.total = payload.length;

    const ceiling = segmentCapacity(opts.grid);
    const parts = segmentPayload(payload, Math.min(opts.segmentBytes ?? ceiling, ceiling));
    if (parts.length > MAX_SEGMENTS) {
      throw new RangeError(
        `payload needs ${parts.length} segments at ${opts.grid}x${opts.grid}, over the ` +
          `${MAX_SEGMENTS} ceiling — use a larger grid or a smaller payload`,
      );
    }

    // Distinct sid8 per segment, or the router would bind symbols from one
    // segment to another's decoder while waiting for a manifest. Mirrors the
    // name the transmitter will actually hash.
    const idName = opts.encryption ? "" : (opts.name ?? "payload.bin");
    const nonces = assignNonces(
      parts.map((part) => ({ fileCRC: crc32(part), total: part.length, name: idName })),
    );

    this.segments = parts.map(
      (part, i) =>
        new Transmitter(part, {
          grid: opts.grid,
          nonce: nonces[i],
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.enhancement !== undefined ? { enhancement: opts.enhancement } : {}),
          ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
          ...(opts.encryption !== undefined ? { encryption: opts.encryption } : {}),
          // A lone object is just a session; the SET record would only cost
          // manifest bytes that a small grid cannot spare.
          ...(parts.length > 1
            ? { set: { setId: this.setId, objIndex: i, objCount: parts.length } }
            : {}),
        }),
    );

    const enhancement = opts.enhancement ?? true;
    this.dwell = this.segments.map((segment) =>
      opts.framesPerSegment !== undefined
        ? opts.framesPerSegment
        : dwellFrames(segment.encoder.K, enhancement),
    );
  }

  get objIndex(): number {
    return this.index;
  }

  get objCount(): number {
    return this.segments.length;
  }

  get current(): Transmitter {
    return this.segments[this.index];
  }

  get geometry() {
    return this.current.geometry;
  }

  get sessionId(): number {
    return this.current.sessionId;
  }

  get encoder() {
    return this.current.encoder;
  }

  next(): { grid: CellGrid; stats: FrameStats } {
    const frame = this.current.next();
    if (++this.framesOnSegment >= this.dwell[this.index]) {
      this.framesOnSegment = 0;
      this.index = (this.index + 1) % this.segments.length;
    }
    return frame;
  }
}

export interface SetProgress {
  readonly setId: number;
  readonly name: string;
  readonly received: number;
  readonly count: number;
  /** Present once every segment has arrived. */
  readonly bytes: Uint8Array | null;
  /** Whole-payload CRC check, available only when `bytes` is. */
  readonly verified: boolean;
}

interface SetEntry {
  readonly name: string;
  readonly count: number;
  readonly parts: Map<number, Uint8Array>;
}

/**
 * Collects completed sessions back into the object they were cut from.
 * Segments may arrive in any order and across several loop passes.
 */
export class SetAssembler {
  private readonly sets = new Map<number, SetEntry>();

  /** Segments banked so far. Progress on the segment currently on screen is
   *  the live session's business, not the assembler's. */
  completed(setId: number): number {
    return this.sets.get(setId)?.parts.size ?? 0;
  }

  /** Bytes banked so far, for a rate estimate that survives segment changes. */
  bytes(setId: number): number {
    let total = 0;
    for (const part of this.sets.get(setId)?.parts.values() ?? []) total += part.length;
    return total;
  }

  /** Returns null for a session that is not part of a multi-object set. */
  add(manifest: Manifest, bytes: Uint8Array): SetProgress | null {
    const set = manifest.set;
    if (!set || set.objCount <= 1) return null;

    let entry = this.sets.get(set.setId);
    if (!entry) {
      entry = { name: manifest.name, count: set.objCount, parts: new Map() };
      this.sets.set(set.setId, entry);
    }
    entry.parts.set(set.objIndex, bytes);

    const base = {
      setId: set.setId,
      name: entry.name,
      received: entry.parts.size,
      count: entry.count,
    };
    if (entry.parts.size < entry.count) return { ...base, bytes: null, verified: false };

    let length = 0;
    for (let i = 0; i < entry.count; i++) length += entry.parts.get(i)!.length;

    const joined = new Uint8Array(length);
    let off = 0;
    for (let i = 0; i < entry.count; i++) {
      const part = entry.parts.get(i)!;
      joined.set(part, off);
      off += part.length;
    }

    return { ...base, bytes: joined, verified: crc32(joined) === set.setId };
  }
}
