import { test } from "node:test";
import assert from "node:assert/strict";

import { CryptoSuite, KEY_BYTES, TAG_BYTES, generateKey, open, seal } from "../src/core/crypto.ts";
import { openPayload, sealPayload } from "../src/core/envelope.ts";
import { geometry } from "../src/core/geometry.ts";
import { packManifest, parseManifest } from "../src/core/manifest.ts";
import { Transmitter } from "../src/core/transmitter.ts";
import { randomBytes } from "./helpers.ts";

const KEY = new Uint8Array(KEY_BYTES).fill(7);
const OTHER_KEY = new Uint8Array(KEY_BYTES).fill(9);
const KEY_ID = 0x1234abcd;

test("seal round-trips", async () => {
  const plaintext = randomBytes(3000, 1);
  const sealed = await seal(plaintext, KEY, KEY_ID);
  assert.equal(sealed.length, plaintext.length + TAG_BYTES);
  assert.deepEqual(await open(sealed, KEY, KEY_ID), plaintext);
});

test("sealing is deterministic, which is what keeps session ids stable", async () => {
  const plaintext = randomBytes(2000, 2);
  const a = await seal(plaintext, KEY, KEY_ID);
  const b = await seal(plaintext, KEY, KEY_ID);
  assert.deepEqual(a, b, "same input must give byte-identical output");

  // A different plaintext must not reuse the counter.
  const other = await seal(randomBytes(2000, 3), KEY, KEY_ID);
  assert.notDeepEqual(a.subarray(0, TAG_BYTES), other.subarray(0, TAG_BYTES));
});

test("the wrong key does not open an envelope", async () => {
  const sealed = await seal(randomBytes(1500, 4), KEY, KEY_ID);
  assert.equal(await open(sealed, OTHER_KEY, KEY_ID), null);
});

test("a tampered ciphertext or tag is rejected", async () => {
  const plaintext = randomBytes(1500, 5);
  const sealed = await seal(plaintext, KEY, KEY_ID);

  const flippedBody = sealed.slice();
  flippedBody[TAG_BYTES + 100] ^= 0x01;
  assert.equal(await open(flippedBody, KEY, KEY_ID), null);

  const flippedTag = sealed.slice();
  flippedTag[3] ^= 0x01;
  assert.equal(await open(flippedTag, KEY, KEY_ID), null);

  const truncated = sealed.subarray(0, sealed.length - 1);
  assert.equal(await open(truncated, KEY, KEY_ID), null);
});

test("the key id is bound into the tag", async () => {
  const sealed = await seal(randomBytes(800, 6), KEY, KEY_ID);
  assert.equal(await open(sealed, KEY, KEY_ID + 1), null, "a different key id must not open it");
});

test("an unsupported suite is refused rather than guessed at", async () => {
  const plaintext = randomBytes(400, 8);
  await assert.rejects(() => seal(plaintext, KEY, KEY_ID, 99 as CryptoSuite), /unsupported suite/);
  const sealed = await seal(plaintext, KEY, KEY_ID);
  assert.equal(await open(sealed, KEY, KEY_ID, 99 as CryptoSuite), null);
});

test("a short master key is refused", async () => {
  await assert.rejects(() => seal(randomBytes(100, 9), new Uint8Array(16), KEY_ID), /32 bytes/);
});

test("generateKey produces distinct full-length keys", () => {
  const a = generateKey();
  const b = generateKey();
  assert.equal(a.length, KEY_BYTES);
  assert.notDeepEqual(a, b);
});

test("ciphertext carries no plaintext structure", async () => {
  // A pathological low-entropy payload: if any structure leaked into the
  // envelope it would show up as a byte histogram spike.
  const plaintext = new Uint8Array(8192).fill(0x41);
  const sealed = await seal(plaintext, KEY, KEY_ID);

  const histogram = new Int32Array(256);
  for (const b of sealed.subarray(TAG_BYTES)) histogram[b]++;
  const peak = Math.max(...histogram);
  const expected = 8192 / 256;
  assert.ok(peak < expected * 3, `byte histogram peak ${peak} suggests structure leaked`);
});

test("envelope carries metadata that the public manifest no longer sees", async () => {
  const file = randomBytes(1200, 11);
  const expiresAt = Date.now() + 60_000;
  const sealed = await sealPayload(
    file,
    { name: "salaries-2026.xlsx", contentType: "application/vnd.ms-excel", expiresAt },
    KEY,
    KEY_ID,
  );

  const opened = await openPayload(sealed, KEY, KEY_ID);
  assert.ok(opened);
  assert.equal(opened.metadata.name, "salaries-2026.xlsx");
  assert.equal(opened.metadata.contentType, "application/vnd.ms-excel");
  assert.equal(opened.metadata.expiresAt, expiresAt);
  assert.equal(opened.expired, false);
  assert.deepEqual(opened.bytes, file);

  // The filename must not be recoverable from the sealed bytes.
  const haystack = Buffer.from(sealed).toString("latin1");
  assert.ok(!haystack.includes("salaries"), "the name must not survive in the envelope");
});

test("expiry is reported but the payload is still returned", async () => {
  const file = randomBytes(300, 12);
  const past = Date.now() - 60_000;
  const sealed = await sealPayload(file, { name: "old.bin", expiresAt: past }, KEY, KEY_ID);

  const opened = await openPayload(sealed, KEY, KEY_ID);
  assert.ok(opened);
  assert.equal(opened.expired, true);
  assert.deepEqual(opened.bytes, file, "policy is the caller's to apply, not ours");
});

test("openPayload rejects a wrong key without leaking a partial parse", async () => {
  const sealed = await sealPayload(randomBytes(600, 13), { name: "x.bin" }, KEY, KEY_ID);
  assert.equal(await openPayload(sealed, OTHER_KEY, KEY_ID), null);
});

test("the encryption marker fits the smallest grid's manifest", () => {
  const g = geometry(48);
  const packed = packManifest(
    {
      sessionId: 1,
      total: 640,
      K: 20,
      symBytes: g.symBytes,
      fileCRC: 2,
      name: "",
      encryption: { suite: CryptoSuite.A256SIV_HS256, keyId: KEY_ID },
    },
    g.symBytes,
  );
  const out = parseManifest(packed);
  assert.ok(out);
  assert.deepEqual(out.encryption, { suite: CryptoSuite.A256SIV_HS256, keyId: KEY_ID });
});

test("the transmitter refuses to put a name in a public manifest when encrypting", async () => {
  const sealed = await sealPayload(randomBytes(500, 14), { name: "secret.pdf" }, KEY, KEY_ID);
  assert.throws(
    () =>
      new Transmitter(sealed, {
        grid: 64,
        name: "secret.pdf",
        encryption: { suite: CryptoSuite.A256SIV_HS256, keyId: KEY_ID },
      }),
    /must not be given alongside encryption/,
  );
});

test("an encrypted session keeps a stable id across loop passes", async () => {
  const file = randomBytes(2000, 15);
  const meta = { name: "loop.bin" };

  const first = await sealPayload(file, meta, KEY, KEY_ID);
  const second = await sealPayload(file, meta, KEY, KEY_ID);
  const encryption = { suite: CryptoSuite.A256SIV_HS256, keyId: KEY_ID };

  const a = new Transmitter(first, { grid: 64, encryption });
  const b = new Transmitter(second, { grid: 64, encryption });

  assert.equal(
    a.sessionId,
    b.sessionId,
    "a re-sealed object must keep its id, or loop accumulation breaks",
  );
});
