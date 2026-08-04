/**
 * Transmitter — drives the encoder and produces one cell grid per frame.
 *
 * DOM-free by construction: it hands back a `CellGrid`, and a renderer turns
 * that into pixels. That split is what lets the codec be tested headlessly
 * and reused outside a browser.
 */

import { geometry, NBANDS, type Geometry } from "./geometry.ts";
import { CHROMA_BAND, FrameType, packBand } from "./framing.ts";
import { LTEncoder } from "./lt.ts";
import { packManifest, type Manifest, type SetMembership } from "./manifest.ts";
import { deriveSessionId, shortId } from "./session.ts";
import {
  collapseToMonochrome,
  createGrid,
  drawQuietStructure,
  writeChromaPlane,
  writeLumaBand,
  type CellGrid,
} from "./raster.ts";

/** Frames between manifest repeats. Four keeps sync under a second at 5 fps. */
export const MANIFEST_INTERVAL = 4;

export interface TransmitterOptions {
  readonly grid: number;
  /** Blue-axis enhancement layer. Off collapses the band region to black and
   *  white: one symbol per frame cheaper, but a far wider luma margin. */
  readonly enhancement?: boolean;
  readonly name?: string;
  readonly contentType?: string;
  readonly set?: SetMembership;
  /** Perturbs the session id so a playlist can avoid sid8 collisions. */
  readonly nonce?: number;
}

export interface FrameStats {
  /** Fountain symbols placed in this frame (excludes manifest and close). */
  readonly symbols: number;
  readonly frameIndex: number;
  readonly manifestSent: boolean;
}

export class Transmitter {
  readonly geometry: Geometry;
  readonly encoder: LTEncoder;
  readonly manifest: Manifest;
  readonly sessionId: number;
  readonly enhancement: boolean;

  private frameIndex = 0;
  private closingIn: number | null = null;

  constructor(payload: Uint8Array, opts: TransmitterOptions) {
    this.geometry = geometry(opts.grid);
    this.encoder = new LTEncoder(payload, this.geometry.symBytes);
    this.enhancement = opts.enhancement ?? true;

    const name = opts.name ?? "payload.bin";
    this.sessionId = deriveSessionId(
      this.encoder.fileCRC,
      this.encoder.total,
      name,
      opts.nonce ?? 0,
    );
    this.manifest = {
      sessionId: this.sessionId,
      total: this.encoder.total,
      K: this.encoder.K,
      symBytes: this.geometry.symBytes,
      fileCRC: this.encoder.fileCRC,
      name,
      ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      ...(opts.set !== undefined ? { set: opts.set } : {}),
    };
  }

  get frames(): number {
    return this.frameIndex;
  }

  /** Announce that the fountain stops in `frames`. Advisory only — see
   *  SPEC.md §6; a receiver must never depend on observing it. */
  announceClose(frames: number): void {
    this.closingIn = Math.max(0, Math.min(0xffff, frames));
  }

  /** Render the next frame. */
  next(): { grid: CellGrid; stats: FrameStats } {
    const geo = this.geometry;
    const sid8 = shortId(this.sessionId);
    const grid = createGrid(geo.W);
    drawQuietStructure(grid);

    let symbols = 0;
    let manifestSent = false;

    for (let band = 0; band < NBANDS; band++) {
      let bits;
      if (band === 0 && this.closingIn !== null) {
        const payload = new Uint8Array(geo.symBytes);
        payload[0] = (this.closingIn >>> 8) & 0xff;
        payload[1] = this.closingIn & 0xff;
        bits = packBand(FrameType.Close, band, 0, sid8, payload, geo.bandCapacity);
      } else if (band === 0 && this.frameIndex % MANIFEST_INTERVAL === 0) {
        const payload = packManifest(this.manifest, geo.symBytes);
        bits = packBand(FrameType.Manifest, band, 0, sid8, payload, geo.bandCapacity);
        manifestSent = true;
      } else {
        const s = this.encoder.next();
        symbols++;
        bits = packBand(FrameType.Data, band, s.esi, sid8, s.data, geo.bandCapacity);
      }
      writeLumaBand(grid, geo, band, bits);
    }

    if (this.enhancement) {
      const s = this.encoder.next();
      symbols++;
      const bits = packBand(
        FrameType.Data,
        CHROMA_BAND,
        s.esi,
        sid8,
        s.data,
        geo.chromaCapacity,
      );
      writeChromaPlane(grid, geo, bits);
    } else {
      collapseToMonochrome(grid);
    }

    const stats: FrameStats = { symbols, frameIndex: this.frameIndex, manifestSent };
    this.frameIndex++;
    if (this.closingIn !== null && this.closingIn > 0) this.closingIn--;
    return { grid, stats };
  }
}
