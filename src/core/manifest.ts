/**
 * Session manifest — the bootstrap record a receiver needs before any
 * fountain symbol means anything.
 *
 * Sent uncoded so a receiver joining mid-transmission can sync from a single
 * good read. Fixed 18-byte core followed by TLV extensions, so unknown
 * fields are skippable and the record degrades gracefully into the small
 * symbol budget of a 48x48 grid.
 *
 *   0      magic 0x4C ('L')
 *   1      version
 *   2..5   sessionId  u32  content-derived, see session.ts
 *   6..9   total      u32  payload length in bytes
 *   10..11 K          u16  source blocks
 *   12..13 symBytes   u16  payload bytes per symbol
 *   14..17 fileCRC    u32  CRC-32 of the whole payload
 *   18..        TLVs: tag u8, len u8, value[len]
 */

import { readU16BE, readU32BE, writeU16BE, writeU32BE } from "./bits.ts";
import { MAX_K } from "./lt.ts";

export const MANIFEST_MAGIC = 0x4c;
export const MANIFEST_VERSION = 2;
export const MANIFEST_CORE_BYTES = 18;

export const Tlv = {
  End: 0,
  Name: 1,
  ContentType: 2,
  /** setId u32, objIndex u16, objCount u16 */
  Set: 3,
  /** Reserved: detached signature over the core record. Not yet defined. */
  Signature: 4,
  /** suite u8, keyId u32 — the payload is a sealed envelope (SPEC.md §11). */
  Encryption: 5,
} as const;

export interface SetMembership {
  readonly setId: number;
  readonly objIndex: number;
  readonly objCount: number;
}

/**
 * Marks the payload as encrypted and says which key opens it. Deliberately
 * tiny — 5 bytes of value, 7 with framing — so it fits even the 13 spare
 * manifest bytes a 48x48 grid leaves. Anything larger, such as a per-recipient
 * wrapped key, belongs in the payload rather than here (SPEC.md §11.4).
 */
export interface EncryptionInfo {
  readonly suite: number;
  readonly keyId: number;
}

export interface Manifest {
  readonly sessionId: number;
  readonly total: number;
  readonly K: number;
  readonly symBytes: number;
  readonly fileCRC: number;
  readonly name: string;
  readonly contentType?: string;
  readonly set?: SetMembership;
  /** Present when the payload is a sealed envelope. In that case `name` and
   *  `contentType` are absent here and live inside the envelope instead. */
  readonly encryption?: EncryptionInfo;
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

/**
 * Serialise into exactly `size` bytes. Extensions are written in priority
 * order and dropped whole when they do not fit, so a 48x48 grid still carries
 * a usable record.
 */
export function packManifest(m: Manifest, size: number): Uint8Array {
  if (size < MANIFEST_CORE_BYTES + 1) {
    throw new RangeError(`manifest needs at least ${MANIFEST_CORE_BYTES + 1} bytes`);
  }
  const b = new Uint8Array(size);
  b[0] = MANIFEST_MAGIC;
  b[1] = MANIFEST_VERSION;
  writeU32BE(b, 2, m.sessionId);
  writeU32BE(b, 6, m.total);
  writeU16BE(b, 10, m.K);
  writeU16BE(b, 12, m.symBytes);
  writeU32BE(b, 14, m.fileCRC);

  let p = MANIFEST_CORE_BYTES;
  const room = () => size - p - 1; // keep one byte for the End tag

  const put = (tag: number, value: Uint8Array): void => {
    if (value.length > 255 || value.length + 2 > room()) return;
    b[p++] = tag;
    b[p++] = value.length;
    b.set(value, p);
    p += value.length;
  };

  // Encryption first: without it a receiver cannot even tell that what it
  // reassembled needs opening, and it is the smallest extension there is.
  if (m.encryption) {
    const v = new Uint8Array(5);
    v[0] = m.encryption.suite & 0xff;
    writeU32BE(v, 1, m.encryption.keyId);
    put(Tlv.Encryption, v);
  }

  // Set membership next: without it a receiver cannot tell where an object
  // sits in a loop, and it is a fixed small cost.
  if (m.set && m.set.objCount > 1) {
    const v = new Uint8Array(8);
    writeU32BE(v, 0, m.set.setId);
    writeU16BE(v, 4, m.set.objIndex);
    writeU16BE(v, 6, m.set.objCount);
    put(Tlv.Set, v);
  }

  // Name, truncated on a UTF-8 boundary rather than dropped outright.
  if (m.name) {
    let encoded: Uint8Array = utf8.encode(m.name);
    if (encoded.length + 2 > room()) encoded = truncateUtf8(encoded, Math.max(0, room() - 2));
    if (encoded.length > 0) put(Tlv.Name, encoded);
  }

  if (m.contentType) put(Tlv.ContentType, utf8.encode(m.contentType));

  b[p] = Tlv.End;
  return b;
}

/** Trim a UTF-8 buffer to at most `max` bytes without splitting a sequence. */
function truncateUtf8(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

export function parseManifest(b: Uint8Array): Manifest | null {
  if (b.length < MANIFEST_CORE_BYTES) return null;
  if (b[0] !== MANIFEST_MAGIC || b[1] !== MANIFEST_VERSION) return null;

  const sessionId = readU32BE(b, 2);
  const total = readU32BE(b, 6);
  const K = readU16BE(b, 10);
  const symBytes = readU16BE(b, 12);
  const fileCRC = readU32BE(b, 14);

  if (K < 1 || K > MAX_K) return null;
  if (symBytes < 8 || symBytes > 4096) return null;
  // A payload cannot need more blocks than K promises, nor fewer than K-1.
  if (total > K * symBytes || total <= (K - 1) * symBytes) return null;

  let name = "";
  let contentType: string | undefined;
  let set: SetMembership | undefined;
  let encryption: EncryptionInfo | undefined;

  let p = MANIFEST_CORE_BYTES;
  while (p + 1 < b.length) {
    const tag = b[p];
    if (tag === Tlv.End) break;
    const len = b[p + 1];
    const start = p + 2;
    if (start + len > b.length) break;
    const value = b.subarray(start, start + len);

    switch (tag) {
      case Tlv.Name:
        name = utf8Decode.decode(value);
        break;
      case Tlv.ContentType:
        contentType = utf8Decode.decode(value);
        break;
      case Tlv.Set:
        if (len === 8) {
          set = {
            setId: readU32BE(value, 0),
            objIndex: readU16BE(value, 4),
            objCount: readU16BE(value, 6),
          };
        }
        break;
      case Tlv.Encryption:
        if (len === 5) encryption = { suite: value[0], keyId: readU32BE(value, 1) };
        break;
      default:
        break; // unknown tags are skipped, by design
    }
    p = start + len;
  }

  return {
    sessionId,
    total,
    K,
    symBytes,
    fileCRC,
    name: name || "payload.bin",
    ...(contentType !== undefined ? { contentType } : {}),
    ...(set !== undefined ? { set } : {}),
    ...(encryption !== undefined ? { encryption } : {}),
  };
}
