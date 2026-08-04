/**
 * Encrypted payload envelope.
 *
 * Encryption is a payload transform, not a change to the optical layer. The
 * grid, framing, whitening, fountain code and session routing all stay exactly
 * as they are and stay fully public — hiding the *structure* of a code that is
 * on a screen in a public place would be obscurity, not security. What changes
 * is only what the fountain is fed.
 *
 *   plaintext -> [inner header][file bytes] -> seal() -> [tag][ciphertext]
 *                                                        \___ the payload ___/
 *
 * The inner header carries the metadata that would otherwise sit in the public
 * manifest. A manifest announcing `salaries-2026.xlsx` defeats the point of
 * encrypting its contents, so in encrypted mode NAME and CONTENT_TYPE move in
 * here and the public manifest carries only the suite and key id.
 */

import { readU16BE, writeU16BE } from "./bits.ts";
import { Tlv } from "./manifest.ts";
import { CryptoSuite, open, seal } from "./crypto.ts";

export const INNER_VERSION = 1;

/** Inner-header TLV tags. Shares the manifest tag registry (SPEC.md §5.2). */
export const InnerTlv = {
  End: Tlv.End,
  Name: Tlv.Name,
  ContentType: Tlv.ContentType,
  /** Milliseconds since the Unix epoch, u64be. */
  Expires: 5,
} as const;

export interface EnvelopeMetadata {
  readonly name: string;
  readonly contentType?: string;
  /** Milliseconds since the Unix epoch. Absent means no expiry. */
  readonly expiresAt?: number;
}

export interface OpenedEnvelope {
  readonly metadata: EnvelopeMetadata;
  readonly bytes: Uint8Array;
  /** True when `expiresAt` is set and has passed. The payload is still
   *  returned; deciding what to do about it is the caller's policy. */
  readonly expired: boolean;
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

function packInnerHeader(meta: EnvelopeMetadata): Uint8Array {
  const parts: Uint8Array[] = [];

  const put = (tag: number, value: Uint8Array): void => {
    if (value.length > 255) throw new RangeError(`inner TLV ${tag} too long`);
    const buf = new Uint8Array(2 + value.length);
    buf[0] = tag;
    buf[1] = value.length;
    buf.set(value, 2);
    parts.push(buf);
  };

  if (meta.name) put(InnerTlv.Name, utf8.encode(meta.name));
  if (meta.contentType) put(InnerTlv.ContentType, utf8.encode(meta.contentType));
  if (meta.expiresAt !== undefined) {
    const v = new Uint8Array(8);
    const ms = BigInt(Math.max(0, Math.floor(meta.expiresAt)));
    for (let i = 0; i < 8; i++) v[i] = Number((ms >> BigInt((7 - i) * 8)) & 0xffn);
    put(InnerTlv.Expires, v);
  }
  parts.push(new Uint8Array([InnerTlv.End]));

  let length = 0;
  for (const p of parts) length += p.length;

  const out = new Uint8Array(3 + length);
  out[0] = INNER_VERSION;
  writeU16BE(out, 1, length);
  let o = 3;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface ParsedInner {
  readonly metadata: EnvelopeMetadata;
  readonly bodyOffset: number;
}

function parseInnerHeader(plaintext: Uint8Array): ParsedInner | null {
  if (plaintext.length < 3) return null;
  if (plaintext[0] !== INNER_VERSION) return null;

  const length = readU16BE(plaintext, 1);
  const end = 3 + length;
  if (end > plaintext.length) return null;

  let name = "";
  let contentType: string | undefined;
  let expiresAt: number | undefined;

  let p = 3;
  while (p + 1 < end) {
    const tag = plaintext[p];
    if (tag === InnerTlv.End) break;
    const len = plaintext[p + 1];
    const start = p + 2;
    if (start + len > end) return null;
    const value = plaintext.subarray(start, start + len);

    switch (tag) {
      case InnerTlv.Name:
        name = utf8Decode.decode(value);
        break;
      case InnerTlv.ContentType:
        contentType = utf8Decode.decode(value);
        break;
      case InnerTlv.Expires:
        if (len === 8) {
          let ms = 0n;
          for (let i = 0; i < 8; i++) ms = (ms << 8n) | BigInt(value[i]);
          expiresAt = Number(ms);
        }
        break;
      default:
        break; // unknown tags are skipped, as in the manifest
    }
    p = start + len;
  }

  return {
    metadata: {
      name: name || "payload.bin",
      ...(contentType !== undefined ? { contentType } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    },
    bodyOffset: end,
  };
}

/**
 * Wrap and encrypt a file into the payload the fountain will carry.
 *
 * Deterministic: the same file, metadata, key and key id always produce a
 * byte-identical envelope, so the session id derived from it is stable across
 * loop passes.
 */
export async function sealPayload(
  file: Uint8Array,
  meta: EnvelopeMetadata,
  key: Uint8Array,
  keyId: number,
  suite: CryptoSuite = CryptoSuite.A256SIV_HS256,
): Promise<Uint8Array> {
  const header = packInnerHeader(meta);
  const plaintext = new Uint8Array(header.length + file.length);
  plaintext.set(header, 0);
  plaintext.set(file, header.length);
  return seal(plaintext, key, keyId, suite);
}

/**
 * Decrypt and unwrap a reassembled payload.
 *
 * @returns null when the key is wrong or the envelope was tampered with.
 * Without the key an observer holds only the sealed bytes, which are
 * indistinguishable from random.
 */
export async function openPayload(
  envelope: Uint8Array,
  key: Uint8Array,
  keyId: number,
  suite: CryptoSuite = CryptoSuite.A256SIV_HS256,
  now: number = Date.now(),
): Promise<OpenedEnvelope | null> {
  const plaintext = await open(envelope, key, keyId, suite);
  if (!plaintext) return null;

  const parsed = parseInnerHeader(plaintext);
  if (!parsed) return null;

  const { metadata } = parsed;
  return {
    metadata,
    bytes: plaintext.subarray(parsed.bodyOffset),
    expired: metadata.expiresAt !== undefined && now > metadata.expiresAt,
  };
}
