/**
 * Deterministic authenticated encryption for Lumen Link payloads.
 *
 * The construction is SIV-style: the authentication tag is computed over the
 * plaintext first, then used as the counter for CTR-mode encryption. There is
 * no nonce to manage and none to misuse — identical plaintext under identical
 * key yields identical ciphertext, which is exactly what the format needs.
 *
 * That determinism is not incidental. Session ids are content-derived so that
 * a playlist cycling A -> B -> C -> A lets a receiver finish A on the second
 * pass (SPEC.md §4.1). A random per-transmission nonce would change the
 * ciphertext, change the session id, and force every receiver to restart from
 * zero on each loop — gutting the use case the id design exists for.
 *
 * Deriving the tag from the plaintext also enforces the safety rule
 * automatically: edit the file and the tag necessarily changes, so the same
 * counter can never cover two different plaintexts under one key.
 *
 * This is SIV-*style*, not RFC 5297 on the wire: it uses HMAC-SHA-256 over a
 * length-prefixed encoding rather than S2V/CMAC. Do not expect interop with
 * an RFC 5297 implementation.
 *
 * Confidentiality only. See SPEC.md §11.5 for what this does not hide.
 */

const subtle = globalThis.crypto.subtle;

export const CryptoSuite = {
  /** HMAC-SHA-256 tag as synthetic IV, AES-256-CTR encryption. */
  A256SIV_HS256: 1,
} as const;
export type CryptoSuite = (typeof CryptoSuite)[keyof typeof CryptoSuite];

/** Master key length. */
export const KEY_BYTES = 32;
/** Synthetic IV, which doubles as the authentication tag. */
export const TAG_BYTES = 16;

const HKDF_MAC_INFO = "lumen-link/v2 siv-mac";
const HKDF_ENC_INFO = "lumen-link/v2 siv-enc";

const utf8 = new TextEncoder();

export function isSupportedSuite(suite: number): suite is CryptoSuite {
  return suite === CryptoSuite.A256SIV_HS256;
}

/** Generate a fresh master key. */
export function generateKey(): Uint8Array {
  const key = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(key);
  return key;
}

interface Subkeys {
  readonly mac: CryptoKey;
  readonly enc: CryptoKey;
}

async function deriveSubkeys(master: Uint8Array): Promise<Subkeys> {
  if (master.length !== KEY_BYTES) {
    throw new RangeError(`master key must be ${KEY_BYTES} bytes, got ${master.length}`);
  }
  const ikm = await subtle.importKey("raw", master as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);

  const derive = async (info: string): Promise<Uint8Array> =>
    new Uint8Array(
      await subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8.encode(info) },
        ikm,
        256,
      ),
    );

  const [macBytes, encBytes] = await Promise.all([
    derive(HKDF_MAC_INFO),
    derive(HKDF_ENC_INFO),
  ]);

  const [mac, enc] = await Promise.all([
    subtle.importKey("raw", macBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]),
    subtle.importKey("raw", encBytes as BufferSource, "AES-CTR", false, ["encrypt", "decrypt"]),
  ]);

  return { mac, enc };
}

/** `u64be(len) || bytes`, so concatenated inputs cannot be re-partitioned. */
function lengthPrefixed(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += 8 + p.length;

  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    const n = BigInt(p.length);
    for (let i = 7; i >= 0; i--) out[o + i] = Number((n >> BigInt((7 - i) * 8)) & 0xffn);
    o += 8;
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function computeTag(
  keys: Subkeys,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const input = lengthPrefixed(aad, plaintext);
  const full = new Uint8Array(await subtle.sign("HMAC", keys.mac, input as BufferSource));
  return full.subarray(0, TAG_BYTES);
}

/**
 * Counter block from the tag. Bits 31 and 63 (counting from the right) are
 * cleared, as RFC 5297 does, so that incrementing the low 32 bits over a long
 * message cannot carry into the rest of the block.
 */
function counterFromTag(tag: Uint8Array): Uint8Array {
  const counter = tag.slice(0, 16);
  counter[8] &= 0x7f;
  counter[12] &= 0x7f;
  return counter;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Context bound into the tag, so a ciphertext cannot be replayed under a
 *  different suite or key id. */
export function associatedData(suite: number, keyId: number): Uint8Array {
  const aad = new Uint8Array(5);
  aad[0] = suite & 0xff;
  aad[1] = (keyId >>> 24) & 0xff;
  aad[2] = (keyId >>> 16) & 0xff;
  aad[3] = (keyId >>> 8) & 0xff;
  aad[4] = keyId & 0xff;
  return aad;
}

/**
 * Seal a plaintext. Returns `tag || ciphertext`.
 *
 * Deterministic: the same plaintext, key, suite and key id always produce
 * byte-identical output.
 */
export async function seal(
  plaintext: Uint8Array,
  key: Uint8Array,
  keyId: number,
  suite: CryptoSuite = CryptoSuite.A256SIV_HS256,
): Promise<Uint8Array> {
  if (!isSupportedSuite(suite)) throw new RangeError(`unsupported suite ${suite}`);

  const keys = await deriveSubkeys(key);
  const tag = await computeTag(keys, associatedData(suite, keyId), plaintext);

  const ciphertext = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-CTR", counter: counterFromTag(tag) as BufferSource, length: 32 },
      keys.enc,
      plaintext as BufferSource,
    ),
  );

  const out = new Uint8Array(TAG_BYTES + ciphertext.length);
  out.set(tag, 0);
  out.set(ciphertext, TAG_BYTES);
  return out;
}

/**
 * Open a sealed envelope.
 *
 * @returns the plaintext, or null if the key is wrong or the envelope was
 * tampered with. Callers **must** treat null as "no data", never as empty
 * data — this is the only check that catches a forged transmission.
 */
export async function open(
  envelope: Uint8Array,
  key: Uint8Array,
  keyId: number,
  suite: CryptoSuite = CryptoSuite.A256SIV_HS256,
): Promise<Uint8Array | null> {
  if (!isSupportedSuite(suite)) return null;
  if (envelope.length < TAG_BYTES) return null;

  const keys = await deriveSubkeys(key);
  const tag = envelope.subarray(0, TAG_BYTES);
  const ciphertext = envelope.subarray(TAG_BYTES);

  const plaintext = new Uint8Array(
    await subtle.decrypt(
      { name: "AES-CTR", counter: counterFromTag(tag) as BufferSource, length: 32 },
      keys.enc,
      ciphertext as BufferSource,
    ),
  );

  // Recompute over the recovered plaintext and compare. In SIV the tag is the
  // IV, so a wrong key yields garbage plaintext whose tag will not match.
  const expected = await computeTag(keys, associatedData(suite, keyId), plaintext);
  return timingSafeEqual(tag, expected) ? plaintext : null;
}
