/**
 * Encrypted transfers through the full optical pipeline.
 *
 * The point of these is the negative case: an observer who reads the code
 * perfectly, decodes every band, and reassembles the payload byte-for-byte
 * still ends up with nothing usable without the key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CryptoSuite, KEY_BYTES } from "../src/core/crypto.ts";
import { openPayload, sealPayload } from "../src/core/envelope.ts";
import { geometry } from "../src/core/geometry.ts";
import { Transmitter } from "../src/core/transmitter.ts";
import { Receiver } from "../src/receiver.ts";
import type { Session } from "../src/core/session.ts";
import { randomBytes, renderGrid } from "./helpers.ts";

const KEY = new Uint8Array(KEY_BYTES).fill(0x2a);
const OTHER_KEY = new Uint8Array(KEY_BYTES).fill(0x3b);
const KEY_ID = 0xfeedface;
const ENCRYPTION = { suite: CryptoSuite.A256SIV_HS256, keyId: KEY_ID };
const MAX_FRAMES = 400;

/** Run a sealed payload through transmit -> render -> receive. */
function transfer(sealed: Uint8Array, seed: number): Session {
  const tx = new Transmitter(sealed, { grid: 64, encryption: ENCRYPTION });
  const rx = new Receiver(geometry(64));

  for (let i = 0; i < MAX_FRAMES; i++) {
    const outcome = rx.processFrame(renderGrid(tx.next().grid, { seed: seed + i }));
    if (outcome.completed) return outcome.completed;
  }
  assert.fail("encrypted transfer did not converge");
}

test("an encrypted file survives the optical round trip and opens with the key", async () => {
  const file = randomBytes(2400, 61);
  const sealed = await sealPayload(
    file,
    { name: "confidential.pdf", contentType: "application/pdf" },
    KEY,
    KEY_ID,
  );

  const session = transfer(sealed, 1000);
  const { bytes, ok } = session.decoder.verify();
  assert.ok(ok, "reassembly must verify against the ciphertext CRC");
  assert.deepEqual(bytes, sealed);

  const opened = await openPayload(bytes, KEY, KEY_ID);
  assert.ok(opened);
  assert.equal(opened.metadata.name, "confidential.pdf");
  assert.equal(opened.metadata.contentType, "application/pdf");
  assert.deepEqual(opened.bytes, file);
});

test("an observer without the key reassembles the payload and still gets nothing", async () => {
  const file = randomBytes(2400, 62);
  const sealed = await sealPayload(file, { name: "confidential.pdf" }, KEY, KEY_ID);

  const session = transfer(sealed, 2000);
  const { bytes, ok } = session.decoder.verify();

  // The observer's read is perfect. That is the point: perfect reception is
  // not the security boundary, key possession is.
  assert.ok(ok);
  assert.deepEqual(bytes, sealed);

  assert.equal(await openPayload(bytes, OTHER_KEY, KEY_ID), null);
  assert.equal(await openPayload(bytes, KEY, KEY_ID + 1), null);

  // Nor is the plaintext sitting in the reassembled bytes.
  const haystack = Buffer.from(bytes).toString("latin1");
  assert.ok(!haystack.includes("confidential"));
  assert.ok(Buffer.from(bytes).indexOf(Buffer.from(file)) === -1, "plaintext must not appear");
});

test("the public manifest of an encrypted session reveals no name or type", async () => {
  const sealed = await sealPayload(
    randomBytes(1800, 63),
    { name: "board-minutes.docx", contentType: "application/msword" },
    KEY,
    KEY_ID,
  );

  const session = transfer(sealed, 3000);
  const manifest = session.manifest;

  assert.deepEqual(manifest.encryption, ENCRYPTION, "the marker must be public");
  assert.equal(manifest.contentType, undefined);
  assert.notEqual(manifest.name, "board-minutes.docx");
  assert.ok(
    manifest.name === "" || manifest.name === "payload.bin",
    `expected a placeholder name, got ${manifest.name}`,
  );

  // What the manifest does still expose, stated plainly (SPEC.md §11.5).
  assert.equal(manifest.total, sealed.length, "size is not hidden");
});

test("a tampered transmission fails to open even though every band passed CRC", async () => {
  const file = randomBytes(1600, 64);
  const sealed = await sealPayload(file, { name: "signed.bin" }, KEY, KEY_ID);

  // An attacker who re-transmits with one byte changed produces a perfectly
  // valid-looking session: bands pass, the ciphertext CRC matches its own
  // manifest. Only the AEAD tag catches it.
  const forged = sealed.slice();
  forged[500] ^= 0xff;

  const session = transfer(forged, 4000);
  const { bytes, ok } = session.decoder.verify();
  assert.ok(ok, "the optical layer cannot tell the difference");
  assert.deepEqual(bytes, forged);

  assert.equal(await openPayload(bytes, KEY, KEY_ID), null, "the tag must catch it");
});

test("encrypted objects still accumulate across a loop pass", async () => {
  const file = randomBytes(9000, 65);
  const sealed = await sealPayload(file, { name: "big.bin" }, KEY, KEY_ID);

  const rx = new Receiver(geometry(64));

  // First pass: the object plays for a while, then the loop moves on.
  const passOne = new Transmitter(sealed, { grid: 64, encryption: ENCRYPTION });
  for (let i = 0; i < 12; i++) rx.processFrame(renderGrid(passOne.next().grid, { seed: 5000 + i }));

  const session = rx.activeSession;
  assert.ok(session);
  assert.ok(!session.decoder.complete, "precondition: unfinished after the first pass");
  const afterFirst = session.decoder.distinctSeen;
  assert.ok(afterFirst > 0);

  // Second pass: re-sealed from scratch, as a real transmitter would do.
  const resealed = await sealPayload(file, { name: "big.bin" }, KEY, KEY_ID);
  const passTwo = new Transmitter(resealed, { grid: 64, encryption: ENCRYPTION });

  let completed: Session | null = null;
  for (let i = 0; i < MAX_FRAMES && !completed; i++) {
    completed = rx.processFrame(renderGrid(passTwo.next().grid, { seed: 6000 + i })).completed;
  }

  assert.ok(completed, "the second pass should finish the object");
  assert.equal(completed, session, "it must be the same session, not a restart");
  assert.ok(
    completed.decoder.distinctSeen > afterFirst,
    "the second pass must build on the first",
  );

  const opened = await openPayload(completed.decoder.verify().bytes, KEY, KEY_ID);
  assert.ok(opened);
  assert.deepEqual(opened.bytes, file);
});
