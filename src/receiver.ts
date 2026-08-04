/**
 * Receiver — the whole read path in one object: pixels in, decoded sessions
 * out. DOM-free, so the same pipeline runs against a camera frame, a
 * simulated capture, or a fixture in a test.
 */

import type { Geometry } from "./core/geometry.ts";
import { SessionRouter, type Session } from "./core/session.ts";
import { FrameDecoder } from "./vision/decode.ts";
import { toGrayscale, type RgbaImage } from "./vision/image.ts";
import { findMarkerBlobs, orderCorners } from "./vision/markers.ts";
import { otsu } from "./vision/threshold.ts";
import type { Homography } from "./vision/homography.ts";

export interface ReceiverStats {
  framesSeen: number;
  framesLocked: number;
  bandsTried: number;
  bandsPassed: number;
  chromaTried: number;
  chromaPassed: number;
  /** Payload bytes absorbed as new symbols. */
  bytesAccepted: number;
  separation: number;
}

export interface FrameOutcome {
  readonly locked: boolean;
  readonly homography: Homography | null;
  readonly bandsPassed: number;
  readonly bandsTried: number;
  readonly chromaPassed: number;
  readonly chromaTried: number;
  readonly separation: number;
  /** Set when a manifest for a different session arrived this frame. */
  readonly switchedTo: Session | null;
  /** Set on the frame that completes a session. */
  readonly completed: Session | null;
}

export class Receiver {
  readonly router: SessionRouter;
  readonly stats: ReceiverStats = {
    framesSeen: 0,
    framesLocked: 0,
    bandsTried: 0,
    bandsPassed: 0,
    chromaTried: 0,
    chromaPassed: 0,
    bytesAccepted: 0,
    separation: 0,
  };

  private readonly decoder: FrameDecoder;
  private readonly finished = new Set<number>();
  private readonly geometry: Geometry;

  constructor(geometry: Geometry, router = new SessionRouter()) {
    this.geometry = geometry;
    this.decoder = new FrameDecoder(geometry);
    this.router = router;
  }

  get activeSession(): Session | null {
    return this.router.activeSession;
  }

  processFrame(img: RgbaImage): FrameOutcome {
    this.stats.framesSeen++;

    const gray = toGrayscale(img);
    const blobs = findMarkerBlobs(gray, img.width, img.height, otsu(gray));
    const corners = orderCorners(blobs);
    if (!corners) return miss();

    const readout = this.decoder.decode(img, corners);
    if (!readout) return miss();

    this.stats.framesLocked++;
    this.stats.bandsTried += readout.bandsTried;
    this.stats.bandsPassed += readout.bandsPassed;
    this.stats.chromaTried += readout.chromaTried;
    this.stats.chromaPassed += readout.chromaPassed;
    this.stats.separation = readout.separation;

    let switchedTo: Session | null = null;
    let completed: Session | null = null;

    for (const frame of readout.frames) {
      const result = this.router.ingest(frame, this.geometry.symBytes);
      switch (result.kind) {
        case "accepted":
          this.stats.bytesAccepted += result.session.decoder.symBytes;
          if (result.session.decoder.complete) completed = result.session;
          break;
        case "manifest":
          if (result.switched) switchedTo = result.session;
          if (result.session.decoder.complete) completed = result.session;
          break;
        default:
          break;
      }
    }

    // Only report a completion once, so a session that keeps receiving
    // symbols after it finished does not re-fire.
    if (completed && this.finished.has(completed.manifest.sessionId)) completed = null;
    if (completed) this.finished.add(completed.manifest.sessionId);

    return {
      locked: true,
      homography: readout.homography,
      bandsPassed: readout.bandsPassed,
      bandsTried: readout.bandsTried,
      chromaPassed: readout.chromaPassed,
      chromaTried: readout.chromaTried,
      separation: readout.separation,
      switchedTo,
      completed,
    };
  }
}

function miss(): FrameOutcome {
  return {
    locked: false,
    homography: null,
    bandsPassed: 0,
    bandsTried: 0,
    chromaPassed: 0,
    chromaTried: 0,
    separation: 0,
    switchedTo: null,
    completed: null,
  };
}
