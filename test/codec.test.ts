import { test } from "node:test";
import assert from "node:assert/strict";

import { crc32 } from "../src/core/crc.ts";
import { LTDecoder, LTEncoder, MAX_K } from "../src/core/lt.ts";
import { geometry, STANDARD_GRIDS } from "../src/core/geometry.ts";
import {
  CHROMA_BAND,
  CRC_BITS,
  FrameType,
  HEADER_BITS,
  bandBitsNeeded,
  packBand,
  unpackBand,
} from "../src/core/framing.ts";
import { packManifest, parseManifest, MANIFEST_VERSION } from "../src/core/manifest.ts";
import { randomBytes } from "./helpers.ts";

test("crc32 matches the standard check vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("standard grids pack header, payload and crc exactly", () => {
  for (const W of STANDARD_GRIDS) {
    const g = geometry(W);
    assert.equal(
      HEADER_BITS + g.symBytes * 8 + CRC_BITS,
      g.bandCapacity,
      `grid ${W} should use its band capacity exactly`,
    );
    assert.equal(g.bandCapacity, g.chromaCapacity, `grid ${W} planes should match`);
  }
});

test("symbol sizes are unchanged by the session id field", () => {
  // The 8-bit sid8 costs 24 bits after triple repetition, which is exactly
  // the slack the old 72-bit header left. See SPEC.md §4.
  assert.equal(geometry(48).symBytes, 32);
  assert.equal(geometry(64).symBytes, 80);
  assert.equal(geometry(80).symBytes, 144);
});

test("band framing round-trips and rejects corruption", () => {
  const g = geometry(64);
  const payload = randomBytes(g.symBytes, 3);
  const bits = packBand(FrameType.Data, 2, 0x1234, 0xab, payload, g.bandCapacity);

  const ok = unpackBand(bits, 2, g.symBytes);
  assert.ok(ok);
  assert.equal(ok.type, FrameType.Data);
  assert.equal(ok.band, 2);
  assert.equal(ok.esi, 0x1234);
  assert.equal(ok.sid8, 0xab);
  assert.deepEqual(ok.payload, payload);

  // A band read with the wrong whitening key must not decode.
  assert.equal(unpackBand(bits, 3, g.symBytes), null);

  // Flipping payload bits must fail the CRC.
  const damaged = bits.slice();
  for (let i = HEADER_BITS; i < HEADER_BITS + 40; i++) damaged[i] ^= 1;
  assert.equal(unpackBand(damaged, 2, g.symBytes), null);
});

test("header survives a contiguous burst that wipes one of its three copies", () => {
  const g = geometry(64);
  const payload = randomBytes(g.symBytes, 5);
  const bits = packBand(FrameType.Manifest, 0, 7, 0x5c, payload, g.bandCapacity);

  const damaged = bits.slice();
  for (let i = 0; i < 32; i++) damaged[i] ^= 1; // clobber copy 0 entirely

  const out = unpackBand(damaged, 0, g.symBytes);
  assert.ok(out, "majority vote should recover the header");
  assert.equal(out.type, FrameType.Manifest);
  assert.equal(out.esi, 7);
  assert.equal(out.sid8, 0x5c);
});

test("chroma band uses its own key so it cannot be confused with band 0", () => {
  const g = geometry(64);
  const payload = randomBytes(g.symBytes, 11);
  const bits = packBand(FrameType.Data, CHROMA_BAND, 9, 1, payload, g.chromaCapacity);

  assert.ok(unpackBand(bits, CHROMA_BAND, g.symBytes));
  assert.equal(unpackBand(bits, 0, g.symBytes), null);
});

test("fountain reconstructs from an arbitrary subset of symbols", () => {
  const payload = randomBytes(4000, 21);
  const enc = new LTEncoder(payload, 80);
  const dec = new LTDecoder(enc.K, 80, enc.total, enc.fileCRC);

  // Drop every third symbol: which ones arrive must not matter.
  let generated = 0;
  while (!dec.complete && generated < 20000) {
    const s = enc.next();
    generated++;
    if (generated % 3 !== 0) dec.add(s.esi, s.data);
  }

  assert.ok(dec.complete, "decoder should converge");
  const { bytes, ok } = dec.verify();
  assert.ok(ok, "reassembled payload should match the file CRC");
  assert.deepEqual(bytes, payload);
});

test("fountain overhead stays within a sane multiple of K", () => {
  const payload = randomBytes(8000, 33);
  const enc = new LTEncoder(payload, 80);
  const dec = new LTDecoder(enc.K, 80, enc.total, enc.fileCRC);

  let used = 0;
  while (!dec.complete && used < 20000) {
    const s = enc.next();
    used++;
    dec.add(s.esi, s.data);
  }
  assert.ok(dec.complete);
  assert.ok(used < enc.K * 2, `used ${used} symbols for K=${enc.K}, expected well under 2x`);
});

test("progress tracks symbols collected, not blocks recovered", () => {
  // Peeling does almost nothing until the graph tips over, so `have` is flat
  // for the whole transfer and then jumps. A bar driven by it tells the user
  // nothing. Measured at K=8192: a full K symbols in recovers 5% of blocks.
  const payload = randomBytes(160_000, 41);
  const enc = new LTEncoder(payload, 80);
  const dec = new LTDecoder(enc.K, 80, enc.total, enc.fileCRC);

  let atHalf = { recovered: 0, progress: 0 };
  while (!dec.complete && enc.emitted < enc.K * 2) {
    const s = enc.next();
    dec.add(s.esi, s.data);
    if (dec.distinctSeen === Math.floor(enc.K / 2)) {
      atHalf = { recovered: dec.have / enc.K, progress: dec.progress };
    }
  }

  assert.ok(dec.complete);
  assert.ok(atHalf.recovered < 0.1, `recovered ${(100 * atHalf.recovered).toFixed(0)}% at the halfway point`);
  assert.ok(
    Math.abs(atHalf.progress - 0.45) < 0.06,
    `progress read ${(100 * atHalf.progress).toFixed(0)}% at the halfway point`,
  );
  assert.equal(dec.progress, 1);
});

test("oversized payloads are refused rather than silently exceeding ESI space", () => {
  const tooBig = new Uint8Array((MAX_K + 1) * 8);
  assert.throws(() => new LTEncoder(tooBig, 8), /segment it across sessions/);
});

test("manifest round-trips through the smallest standard symbol", () => {
  const g = geometry(48);
  const m = {
    sessionId: 0xdeadbeef,
    total: 1000,
    K: 32,
    symBytes: g.symBytes,
    fileCRC: 0x12345678,
    name: "report.pdf",
  };
  const packed = packManifest(m, g.symBytes);
  assert.equal(packed.length, g.symBytes);

  const out = parseManifest(packed);
  assert.ok(out);
  assert.equal(out.sessionId, 0xdeadbeef);
  assert.equal(out.total, 1000);
  assert.equal(out.K, 32);
  assert.equal(out.fileCRC, 0x12345678);
  assert.equal(out.name, "report.pdf");
});

test("manifest carries set membership and content type when there is room", () => {
  const g = geometry(80);
  const packed = packManifest(
    {
      sessionId: 1,
      total: 500,
      K: 4,
      symBytes: g.symBytes,
      fileCRC: 2,
      name: "slide.png",
      contentType: "image/png",
      set: { setId: 0xaabbccdd, objIndex: 3, objCount: 7 },
    },
    g.symBytes,
  );
  const out = parseManifest(packed);
  assert.ok(out);
  assert.equal(out.contentType, "image/png");
  assert.deepEqual(out.set, { setId: 0xaabbccdd, objIndex: 3, objCount: 7 });
});

test("manifest truncates a long name instead of overflowing", () => {
  const g = geometry(48);
  const packed = packManifest(
    {
      sessionId: 1,
      total: 100,
      K: 4,
      symBytes: g.symBytes,
      fileCRC: 2,
      name: "a-very-long-file-name-that-cannot-possibly-fit.bin",
    },
    g.symBytes,
  );
  assert.equal(packed.length, g.symBytes);
  const out = parseManifest(packed);
  assert.ok(out);
  assert.ok(out.name.length > 0);
  assert.ok("a-very-long-file-name-that-cannot-possibly-fit.bin".startsWith(out.name));
});

test("manifest rejects a foreign version and implausible geometry", () => {
  const g = geometry(64);
  const packed = packManifest(
    { sessionId: 1, total: 100, K: 2, symBytes: g.symBytes, fileCRC: 2, name: "x" },
    g.symBytes,
  );

  const wrongVersion = packed.slice();
  wrongVersion[1] = MANIFEST_VERSION + 1;
  assert.equal(parseManifest(wrongVersion), null);

  // total must be consistent with K and symBytes.
  const inconsistent = packed.slice();
  inconsistent[6] = 0xff;
  inconsistent[7] = 0xff;
  assert.equal(parseManifest(inconsistent), null);
});

test("bandBitsNeeded agrees with what packBand will accept", () => {
  const g = geometry(64);
  assert.equal(bandBitsNeeded(g.symBytes), g.bandCapacity);
  assert.throws(
    () => packBand(FrameType.Data, 0, 0, 0, randomBytes(g.symBytes + 8), g.bandCapacity),
    /does not fit/,
  );
});
