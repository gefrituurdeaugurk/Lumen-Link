/**
 * End-to-end tests through the real vision pipeline: transmitter renders a
 * grid, the grid is rasterised the way a capture would see it, and the
 * receiver reads it back. No canvas, no camera, no DOM.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { geometry, STANDARD_GRIDS } from "../src/core/geometry.ts";
import { Transmitter } from "../src/core/transmitter.ts";
import { Receiver } from "../src/receiver.ts";
import { CHROMA_FLOOR } from "../src/vision/decode.ts";
import { randomBytes, renderGrid } from "./helpers.ts";

const MAX_FRAMES = 400;

interface RunResult {
  readonly frames: number;
  readonly locked: number;
  readonly completedName: string | null;
  readonly bytes: Uint8Array | null;
  readonly verified: boolean;
  readonly chromaPassed: number;
  readonly separation: number;
}

function run(
  payload: Uint8Array,
  name: string,
  grid: number,
  render: Parameters<typeof renderGrid>[1] = {},
  opts: { enhancement?: boolean } = {},
): RunResult {
  const tx = new Transmitter(payload, {
    grid,
    name,
    ...(opts.enhancement !== undefined ? { enhancement: opts.enhancement } : {}),
  });
  const rx = new Receiver(geometry(grid));

  for (let i = 0; i < MAX_FRAMES; i++) {
    const { grid: cells } = tx.next();
    const img = renderGrid(cells, { ...render, seed: (render.seed ?? 1) + i });
    const outcome = rx.processFrame(img);
    if (outcome.completed) {
      const { bytes, ok } = outcome.completed.decoder.verify();
      return {
        frames: i + 1,
        locked: rx.stats.framesLocked,
        completedName: outcome.completed.manifest.name,
        bytes,
        verified: ok,
        chromaPassed: rx.stats.chromaPassed,
        separation: rx.stats.separation,
      };
    }
  }
  return {
    frames: MAX_FRAMES,
    locked: rx.stats.framesLocked,
    completedName: null,
    bytes: null,
    verified: false,
    chromaPassed: rx.stats.chromaPassed,
    separation: rx.stats.separation,
  };
}

for (const grid of STANDARD_GRIDS) {
  test(`clean optical round-trip at ${grid}x${grid}`, () => {
    const payload = randomBytes(2400, grid);
    const result = run(payload, "payload.bin", grid);

    assert.ok(result.completedName, `no completion within ${MAX_FRAMES} frames`);
    assert.equal(result.completedName, "payload.bin");
    assert.ok(result.verified, "file CRC must match");
    assert.deepEqual(result.bytes, payload);
    assert.equal(result.locked, result.frames, "every frame should lock");
  });
}

test("survives sensor noise", () => {
  const payload = randomBytes(1800, 5);
  const result = run(payload, "noisy.bin", 64, { noise: 40 });
  assert.ok(result.verified, "should still converge under noise");
  assert.deepEqual(result.bytes, payload);
});

test("the enhancement layer contributes when the blue axis separates", () => {
  const payload = randomBytes(3000, 9);

  const withChroma = run(payload, "x.bin", 64, {}, { enhancement: true });
  assert.ok(withChroma.verified);
  assert.ok(withChroma.chromaPassed > 0, "blue axis should be readable when clean");
  assert.ok(withChroma.separation > CHROMA_FLOOR);

  const withoutChroma = run(payload, "x.bin", 64, {}, { enhancement: false });
  assert.ok(withoutChroma.verified);
  assert.equal(withoutChroma.chromaPassed, 0);

  // Five symbols per frame against four should need fewer frames.
  assert.ok(
    withChroma.frames < withoutChroma.frames,
    `enhancement should reduce frames: ${withChroma.frames} vs ${withoutChroma.frames}`,
  );
});

test("a green ambient collapses the enhancement layer but not the base layer", () => {
  const payload = randomBytes(3000, 13);
  const result = run(payload, "tinted.bin", 64, { greenAmbient: 0.92 });

  assert.ok(result.verified, "base layer must keep converging under a green ambient");
  assert.deepEqual(result.bytes, payload);
  assert.ok(
    result.separation < CHROMA_FLOOR,
    `separation should fall below the floor, got ${result.separation}`,
  );
  assert.equal(result.chromaPassed, 0, "enhancement layer should drop out on its own");
});

test("a receiver joining mid-transmission still syncs and completes", () => {
  const payload = randomBytes(2400, 17);
  const tx = new Transmitter(payload, { grid: 64, name: "late.bin" });
  const rx = new Receiver(geometry(64));

  // Transmit into the void for a while; the receiver is not watching yet.
  for (let i = 0; i < 37; i++) tx.next();

  for (let i = 0; i < MAX_FRAMES; i++) {
    const { grid } = tx.next();
    const outcome = rx.processFrame(renderGrid(grid, { seed: 100 + i }));
    if (outcome.completed) {
      const { bytes, ok } = outcome.completed.decoder.verify();
      assert.ok(ok);
      assert.deepEqual(bytes, payload);
      return;
    }
  }
  assert.fail("late joiner failed to converge");
});

test("switching files mid-stream is detected and both files decode", () => {
  const first = randomBytes(1600, 41);
  const second = randomBytes(1600, 42);
  const rx = new Receiver(geometry(64));

  const txA = new Transmitter(first, { grid: 64, name: "first.bin" });
  let firstDone: Uint8Array | null = null;
  for (let i = 0; i < MAX_FRAMES && !firstDone; i++) {
    const outcome = rx.processFrame(renderGrid(txA.next().grid, { seed: 200 + i }));
    if (outcome.completed) firstDone = outcome.completed.decoder.verify().bytes;
  }
  assert.ok(firstDone, "first file should complete");
  assert.deepEqual(firstDone, first);

  // Same receiver, no reset: the transmitter simply moves to another file.
  const txB = new Transmitter(second, { grid: 64, name: "second.bin" });
  let switched = false;
  let secondDone: Uint8Array | null = null;
  for (let i = 0; i < MAX_FRAMES && !secondDone; i++) {
    const outcome = rx.processFrame(renderGrid(txB.next().grid, { seed: 300 + i }));
    if (outcome.switchedTo) switched = true;
    if (outcome.completed) secondDone = outcome.completed.decoder.verify().bytes;
  }

  assert.ok(switched, "the receiver should notice the new session");
  assert.ok(secondDone, "second file should complete");
  assert.deepEqual(secondDone, second);
});

test("close frames reach the receiver as an advisory", () => {
  const payload = randomBytes(6000, 51);
  const tx = new Transmitter(payload, { grid: 64, name: "closing.bin" });
  const rx = new Receiver(geometry(64));

  for (let i = 0; i < 4; i++) rx.processFrame(renderGrid(tx.next().grid, { seed: 400 + i }));
  tx.announceClose(9);

  let sawClose = false;
  for (let i = 0; i < 6; i++) {
    rx.processFrame(renderGrid(tx.next().grid, { seed: 500 + i }));
    const session = rx.activeSession;
    if (session?.closingIn !== null && session?.closingIn !== undefined) sawClose = true;
  }
  assert.ok(sawClose, "receiver should learn the fountain is closing");
});
