/**
 * Session identity and routing — the layer that answers "does this symbol
 * belong to the file I am currently decoding?"
 *
 * A broadcast fountain has no back channel and no guarantee that a receiver
 * observes the start or end of anything, so object boundaries are carried as
 * *identity on every symbol* rather than as begin/end markers. A receiver
 * that walks up mid-transmission learns the boundary the same way one that
 * was there from the start does: the id changed.
 *
 * Session ids are derived from content, not from a counter. A signage loop
 * that cycles A -> B -> C -> A therefore reuses A's id on the second pass,
 * and a receiver that caught 60% of A the first time round finishes it the
 * second — which costs nothing, because any symbol is as good as any other.
 */

import { crc32 } from "./crc.ts";
import { writeU32BE } from "./bits.ts";
import { LTDecoder } from "./lt.ts";
import { FrameType, type BandFrame } from "./framing.ts";
import { parseManifest, type Manifest } from "./manifest.ts";

/** Sessions kept warm for cross-cycle accumulation. */
export const DEFAULT_SESSION_CACHE = 4;
/** Ceiling on the cache a SET record may ask for. Matches the 8-bit short id
 *  space, which already bounds how many objects a set can hold. */
export const MAX_SESSION_CACHE = 256;
/** Symbols held per unbound sid8 while waiting for a manifest. */
const PENDING_PER_SHORT_ID = 256;
/** Distinct unbound sid8 values tracked at once. */
const PENDING_BUCKETS = 4;

const utf8 = new TextEncoder();

/**
 * Content-derived session id. Identical payload + name + nonce yields an
 * identical id on every transmitter, which is what makes loop accumulation
 * and multi-screen redundancy work.
 */
export function deriveSessionId(
  fileCRC: number,
  total: number,
  name: string,
  nonce = 0,
): number {
  const head = new Uint8Array(12);
  writeU32BE(head, 0, fileCRC);
  writeU32BE(head, 4, total);
  writeU32BE(head, 8, nonce);
  const nameBytes = utf8.encode(name);
  const buf = new Uint8Array(head.length + nameBytes.length);
  buf.set(head);
  buf.set(nameBytes, head.length);
  return crc32(buf);
}

export const shortId = (sessionId: number): number => sessionId & 0xff;

/**
 * Choose per-object nonces so that no two objects in a playlist share a
 * sid8. Only the transmitter can do this — it is the only party that knows
 * the whole set — and it removes the one ambiguity the 8-bit short id has.
 */
export function assignNonces(
  objects: readonly { fileCRC: number; total: number; name: string }[],
): number[] {
  const used = new Set<number>();
  return objects.map((o) => {
    for (let nonce = 0; nonce < 4096; nonce++) {
      const s = shortId(deriveSessionId(o.fileCRC, o.total, o.name, nonce));
      if (!used.has(s)) {
        used.add(s);
        return nonce;
      }
    }
    throw new Error("could not find a collision-free nonce; playlist too large for 8-bit ids");
  });
}

export interface Session {
  readonly manifest: Manifest;
  readonly decoder: LTDecoder;
  /** Frames until the transmitter stops, if it has announced a close. */
  closingIn: number | null;
}

export type IngestResult =
  | { kind: "accepted"; session: Session }
  | { kind: "duplicate"; session: Session }
  | { kind: "manifest"; session: Session; switched: boolean }
  | { kind: "closing"; session: Session; framesRemaining: number }
  | { kind: "buffered"; sid8: number }
  | {
      kind: "ignored";
      reason: "bad-manifest" | "geometry-mismatch" | "sid-mismatch" | "unknown-type";
    };

export class SessionRouter {
  private readonly sessions = new Map<number, Session>();
  private readonly bindings = new Map<number, number>(); // sid8 -> sessionId
  private readonly pending = new Map<number, { esi: number; payload: Uint8Array }[]>();
  private active: number | null = null;
  private cacheSize: number;

  constructor(cacheSize: number = DEFAULT_SESSION_CACHE) {
    this.cacheSize = cacheSize;
  }

  /** The session whose manifest was seen most recently. */
  get activeSession(): Session | null {
    return this.active === null ? null : (this.sessions.get(this.active) ?? null);
  }

  get(sessionId: number): Session | undefined {
    return this.sessions.get(sessionId);
  }

  ingest(frame: BandFrame, symBytes: number): IngestResult {
    switch (frame.type) {
      case FrameType.Manifest:
        return this.onManifest(frame, symBytes);
      case FrameType.Data:
        return this.onData(frame);
      case FrameType.Close:
        return this.onClose(frame);
      default:
        return { kind: "ignored", reason: "unknown-type" };
    }
  }

  private onManifest(frame: BandFrame, symBytes: number): IngestResult {
    const manifest = parseManifest(frame.payload);
    if (!manifest) return { kind: "ignored", reason: "bad-manifest" };

    // The manifest states the symbol size it was produced under. If that
    // disagrees with the geometry we are sampling, we are misreading the
    // grid and must not build a decoder from it.
    if (manifest.symBytes !== symBytes) {
      return { kind: "ignored", reason: "geometry-mismatch" };
    }

    // The band header's short id must be the low byte of the id the manifest
    // declares. A well-formed transmitter derives both from the same value,
    // so a mismatch means a corrupt or forged record, not a late joiner.
    if (frame.sid8 !== shortId(manifest.sessionId)) {
      return { kind: "ignored", reason: "sid-mismatch" };
    }

    const id = manifest.sessionId;
    const switched = this.active !== id;
    let session = this.sessions.get(id);

    // A set is transmitted round-robin, so every segment is partly decoded at
    // once. Evicting one throws away work that will not come round again for
    // a whole pass; the manifest says how many to expect, so hold them all.
    if (manifest.set) {
      this.cacheSize = Math.max(
        this.cacheSize,
        Math.min(manifest.set.objCount, MAX_SESSION_CACHE),
      );
    }

    if (session) {
      this.touch(id);
    } else {
      session = {
        manifest,
        decoder: new LTDecoder(manifest.K, manifest.symBytes, manifest.total, manifest.fileCRC),
        closingIn: null,
      };
      this.sessions.set(id, session);
      this.evictOverflow();
    }

    this.bind(shortId(id), id);
    this.active = id;
    this.drainPending(shortId(id), session);

    return { kind: "manifest", session, switched };
  }

  private onData(frame: BandFrame): IngestResult {
    const id = this.bindings.get(frame.sid8);
    if (id === undefined) return this.buffer(frame);

    const session = this.sessions.get(id);
    if (!session) return this.buffer(frame);

    this.touch(id);
    const fresh = session.decoder.add(frame.esi, frame.payload);
    return fresh ? { kind: "accepted", session } : { kind: "duplicate", session };
  }

  private onClose(frame: BandFrame): IngestResult {
    const id = this.bindings.get(frame.sid8);
    const session = id === undefined ? undefined : this.sessions.get(id);
    if (!session) return { kind: "buffered", sid8: frame.sid8 };

    const framesRemaining = ((frame.payload[0] << 8) | frame.payload[1]) >>> 0;
    session.closingIn = framesRemaining;
    return { kind: "closing", session, framesRemaining };
  }

  private buffer(frame: BandFrame): IngestResult {
    let bucket = this.pending.get(frame.sid8);
    if (!bucket) {
      if (this.pending.size >= PENDING_BUCKETS) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      bucket = [];
      this.pending.set(frame.sid8, bucket);
    }
    if (bucket.length < PENDING_PER_SHORT_ID) {
      bucket.push({ esi: frame.esi, payload: frame.payload });
    }
    return { kind: "buffered", sid8: frame.sid8 };
  }

  /**
   * Point a short id at a session.
   *
   * If it previously pointed at a *different* session, anything buffered
   * under it belongs to that session and must be dropped rather than mixed
   * in — a fountain symbol carries no self-check beyond the band CRC it has
   * already passed, so nothing downstream would catch the contamination
   * before the whole-file CRC fails at the very end.
   *
   * A short id that was never bound is the ordinary late-joiner case: those
   * symbols arrived while we were waiting for exactly this manifest, so they
   * are kept. Transmitters keep that safe by assigning playlist nonces so no
   * two objects in a loop share a short id (see `assignNonces`).
   */
  private bind(sid8: number, sessionId: number): void {
    const previous = this.bindings.get(sid8);
    if (previous !== undefined && previous !== sessionId) {
      this.pending.delete(sid8);
      // Between the switch and this manifest, the new object's data frames
      // carried this same short id and were routed straight into the old
      // session by this very binding. Its state can no longer be trusted, so
      // drop it rather than keep accumulating onto a poisoned decoder.
      this.sessions.delete(previous);
      if (this.active === previous) this.active = null;
    }
    this.bindings.set(sid8, sessionId);
  }

  private drainPending(sid8: number, session: Session): void {
    const queued = this.pending.get(sid8);
    if (!queued) return;
    for (const q of queued) session.decoder.add(q.esi, q.payload);
    this.pending.delete(sid8);
  }

  private touch(id: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.sessions.set(id, s);
  }

  private evictOverflow(): void {
    while (this.sessions.size > this.cacheSize) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
      for (const [s8, id] of this.bindings) if (id === oldest) this.bindings.delete(s8);
      if (this.active === oldest) this.active = null;
    }
  }
}
