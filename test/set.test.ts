/**
 * Segmentation: payloads past the single-session ceiling, carried as a set of
 * objects and reassembled by objIndex (SPEC.md §5.4, §7).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { geometry } from "../src/core/geometry.ts";
import { MAX_K } from "../src/core/lt.ts";
import { Transmitter } from "../src/core/transmitter.ts";
import { SetAssembler, SetTransmitter, segmentCapacity, segmentPayload } from "../src/core/set.ts";
import { Receiver } from "../src/receiver.ts";
import { randomBytes, renderGrid } from "./helpers.ts";

const MAX_FRAMES = 900;

test("a payload over the ceiling is refused by a single session", () => {
  const oversize = new Uint8Array(segmentCapacity(48) + 1);
  assert.throws(() => new Transmitter(oversize, { grid: 48, name: "big.bin" }), RangeError);
});

test("segments are cut to what one session can carry", () => {
  const capacity = segmentCapacity(48);
  const parts = segmentPayload(new Uint8Array(capacity * 2 + 100), capacity);

  assert.equal(parts.length, 3);
  assert.equal(parts[0].length, capacity);
  assert.equal(parts[2].length, 100);
  for (const part of parts) {
    assert.ok(Math.ceil(part.length / geometry(48).symBytes) <= MAX_K);
  }
});

test("a payload needing more segments than there are short ids is refused", () => {
  assert.throws(
    () =>
      new SetTransmitter(new Uint8Array(300 * 100), {
        grid: 48,
        name: "huge.bin",
        segmentBytes: 100,
      }),
    /over the 256 ceiling/,
  );
});

test("a payload that fits stays a single object", () => {
  const tx = new SetTransmitter(randomBytes(500, 11), { grid: 48, name: "small.bin" });
  assert.equal(tx.objCount, 1);
  assert.equal(tx.segments[0].manifest.set, undefined, "one object needs no SET record");
});

test("every segment gets a distinct short id", () => {
  const tx = new SetTransmitter(randomBytes(4000, 13), {
    grid: 48,
    name: "big.bin",
    segmentBytes: 500,
  });

  assert.equal(tx.objCount, 8);
  const shortIds = new Set(tx.segments.map((s) => s.sessionId & 0xff));
  assert.equal(shortIds.size, 8, "sid8 collisions would cross-feed the decoders");
});

test("segments carry a SET record naming their place in the whole", () => {
  const payload = randomBytes(2500, 15);
  const tx = new SetTransmitter(payload, { grid: 48, name: "doc.pdf", segmentBytes: 1000 });

  assert.equal(tx.objCount, 3);
  tx.segments.forEach((segment, i) => {
    assert.deepEqual(segment.manifest.set, { setId: tx.setId, objIndex: i, objCount: 3 });
    assert.equal(segment.manifest.name, "doc.pdf");
  });
});

test("the assembler ignores sessions that are not part of a set", () => {
  const tx = new Transmitter(randomBytes(200, 19), { grid: 48, name: "lone.bin" });
  assert.equal(new SetAssembler().add(tx.manifest, new Uint8Array(200)), null);
});

test("the set id is the whole-payload CRC, so reassembly is verifiable", () => {
  const payload = randomBytes(2500, 23);
  const tx = new SetTransmitter(payload, { grid: 48, name: "verify.bin", segmentBytes: 1000 });

  const assembler = new SetAssembler();
  // Deliberately out of order: segments arrive however the receiver caught them.
  let last = null;
  for (const i of [2, 0, 1]) {
    last = assembler.add(tx.segments[i].manifest, payload.subarray(i * 1000, (i + 1) * 1000));
  }

  assert.ok(last?.bytes, "all segments present");
  assert.equal(last.count, 3);
  assert.ok(last.verified, "the reassembled payload must match the set id");
  assert.deepEqual(last.bytes, payload);
});

test("a corrupt segment fails the whole-set check", () => {
  const payload = randomBytes(2000, 27);
  const tx = new SetTransmitter(payload, { grid: 48, name: "bad.bin", segmentBytes: 1000 });

  const assembler = new SetAssembler();
  assembler.add(tx.segments[0].manifest, payload.subarray(0, 1000));
  const damaged = payload.slice(1000);
  damaged[0] ^= 0xff;
  const last = assembler.add(tx.segments[1].manifest, damaged);

  assert.ok(last?.bytes);
  assert.equal(last.verified, false);
});

test("a segmented payload reassembles through the optical pipeline", () => {
  const payload = randomBytes(2400, 29);
  const tx = new SetTransmitter(payload, {
    grid: 48,
    name: "split.bin",
    segmentBytes: 800,
    framesPerSegment: 30,
  });
  assert.equal(tx.objCount, 3);

  const rx = new Receiver(geometry(48));
  const assembler = new SetAssembler();
  let done: Uint8Array | null = null;

  for (let i = 0; i < MAX_FRAMES && !done; i++) {
    const { grid } = tx.next();
    const outcome = rx.processFrame(renderGrid(grid, { seed: i + 1 }));
    if (!outcome.completed) continue;

    const { bytes, ok } = outcome.completed.decoder.verify();
    assert.ok(ok, "each segment must verify on its own");
    const progress = assembler.add(outcome.completed.manifest, bytes);
    assert.ok(progress, "a segmented session must report set progress");
    if (progress.bytes) done = progress.bytes;
  }

  assert.ok(done, "the set should reassemble");
  assert.deepEqual(done, payload);
});
