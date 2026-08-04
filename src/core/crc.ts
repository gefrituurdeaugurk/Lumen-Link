/** CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320). */

const TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** CRC-32 over the concatenation of several buffers, without allocating a join. */
export function crc32Concat(...parts: readonly Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) {
    for (let i = 0; i < p.length; i++) c = TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
