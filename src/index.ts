/** Lumen Link — rateless optical file transfer. Public surface. */

export { crc32, crc32Concat } from "./core/crc.ts";
export { mulberry32 } from "./core/rng.ts";
export { BitReader, BitWriter, xorInto, type BitPlane } from "./core/bits.ts";

export {
  ESI_SPACE,
  LTDecoder,
  LTEncoder,
  MAX_K,
  solitonCDF,
  symbolBlocks,
  type Symbol as FountainSymbol,
} from "./core/lt.ts";

export {
  geometry,
  bandRow,
  NBANDS,
  STANDARD_GRIDS,
  type Geometry,
  type StandardGrid,
} from "./core/geometry.ts";

export {
  CHROMA_BAND,
  CRC_BITS,
  FrameType,
  HEADER_BITS,
  bandBitsNeeded,
  packBand,
  unpackBand,
  whiteningMask,
  type BandFrame,
} from "./core/framing.ts";

export {
  MANIFEST_CORE_BYTES,
  MANIFEST_MAGIC,
  MANIFEST_VERSION,
  Tlv,
  packManifest,
  parseManifest,
  type Manifest,
  type SetMembership,
} from "./core/manifest.ts";

export {
  DEFAULT_SESSION_CACHE,
  SessionRouter,
  assignNonces,
  deriveSessionId,
  shortId,
  type IngestResult,
  type Session,
} from "./core/session.ts";

export {
  PALETTE,
  calibrationPatchWidth,
  createGrid,
  drawQuietStructure,
  collapseToMonochrome,
  writeChromaPlane,
  writeLumaBand,
  type CellGrid,
} from "./core/raster.ts";

export {
  MANIFEST_INTERVAL,
  Transmitter,
  type FrameStats,
  type TransmitterOptions,
} from "./core/transmitter.ts";

export { CHROMA_FLOOR, FrameDecoder, type FrameReadout } from "./vision/decode.ts";
export { toGrayscale, type RgbaImage } from "./vision/image.ts";
export { findMarkerBlobs, orderCorners, type Blob } from "./vision/markers.ts";
export { otsu } from "./vision/threshold.ts";
export {
  applyHomography,
  homography,
  type Homography,
  type Point,
} from "./vision/homography.ts";

export { Receiver, type FrameOutcome, type ReceiverStats } from "./receiver.ts";
