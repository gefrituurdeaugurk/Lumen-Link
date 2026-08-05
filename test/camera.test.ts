/**
 * Camera-condition tests.
 *
 * The `renderGrid` fixture is a code filling a white field, which is what
 * loopback shows and why loopback is flawless. A phone sees something else: a
 * screen inside a room, tilted, softened by the lens, surrounded by dark
 * things that look exactly like registration markers. These tests hold the
 * read path to the second case.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { geometry } from "../src/core/geometry.ts";
import { Transmitter } from "../src/core/transmitter.ts";
import { Receiver } from "../src/receiver.ts";
import { expectedMarkerRatio, findMarkerQuads, orderCorners } from "../src/vision/markers.ts";
import { randomBytes, renderScene, tearFrames, type SceneOptions } from "./helpers.ts";

const FRAMES = 30;

function lockRate(opts: SceneOptions & { grid?: number; frames?: number }): {
  lock: number;
  band: number;
} {
  const grid = opts.grid ?? 48;
  const tx = new Transmitter(randomBytes(2400, 5), { grid, name: "x.bin" });
  const rx = new Receiver(geometry(grid));
  for (let i = 0; i < (opts.frames ?? FRAMES); i++) {
    rx.processFrame(renderScene(tx.next().grid, { seed: i + 1, ...opts }));
  }
  const s = rx.stats;
  return {
    lock: (100 * s.framesLocked) / s.framesSeen,
    band: s.bandsTried ? (100 * s.bandsPassed) / s.bandsTried : 0,
  };
}

const room: SceneOptions = { clutter: 6, gradient: 0.35, noise: 20 };

test("a code on a screen in a room locks every frame", () => {
  const { lock, band } = lockRate(room);
  assert.equal(lock, 100);
  assert.ok(band > 95, `band ${band.toFixed(0)}%`);
});

test("dark specks on bright surfaces do not steal the corners", () => {
  // Marker lookalikes are what a real room is full of, and picking corners by
  // frame extremes gave them a veto: two were enough to halve the lock rate.
  for (const specks of [2, 8, 30]) {
    const { lock } = lockRate({ ...room, specks });
    assert.equal(lock, 100, `${specks} specks locked ${lock.toFixed(0)}%`);
  }
});

test("a hand-held capture locks through tilt, rotation and defocus", () => {
  const { lock, band } = lockRate({
    ...room,
    specks: 8,
    fill: 0.35,
    blur: 1,
    rotate: 5,
    perspective: 0.2,
  });
  assert.equal(lock, 100);
  assert.ok(band > 90, `band ${band.toFixed(0)}%`);
});

test("a distant code still locks, on both grid sizes", () => {
  for (const grid of [48, 64]) {
    const { lock } = lockRate({
      ...room,
      grid,
      specks: 8,
      fill: grid === 48 ? 0.22 : 0.3,
      blur: 1,
      rotate: 4,
      perspective: 0.15,
    });
    assert.equal(lock, 100, `grid ${grid} locked ${lock.toFixed(0)}%`);
  }
});

test("a denser grid needs a denser capture", () => {
  // Blur tolerance is set by cell pitch in the capture, not by the grid. At a
  // 1280-wide capture 80x80 leaves ~6.5 px a cell and the lens closes it; the
  // same optics over 1920 px leave ~9.8 and it reads clean. This is why the
  // capture is not downscaled to 1280.
  const near = lockRate({ ...room, grid: 80, fill: 0.45, frameWidth: 1280, blur: 2.5, frames: 6 });
  const far = lockRate({ ...room, grid: 80, fill: 0.45, frameWidth: 1920, blur: 3.75, frames: 6 });

  assert.ok(near.band < 80, `1280 capture read ${near.band.toFixed(0)}% of bands`);
  assert.ok(far.band > 95, `1920 capture read ${far.band.toFixed(0)}% of bands`);
});

test("a torn capture costs the chroma symbol but not every band", () => {
  // Each luma band carries its own CRC, so a seam only destroys the band it
  // crosses. The blue plane is one symbol across the whole band region, so any
  // seam at all destroys it — which is why transmitting near the camera's own
  // frame rate collapses chroma while luma degrades gently.
  const grid = 64;
  const tx = new Transmitter(randomBytes(4000, 3), { grid, name: "x.bin" });
  const rx = new Receiver(geometry(grid));
  const scene = { ...room, frameWidth: 1280, fill: 0.45, blur: 1, seed: 1 };

  let previous = renderScene(tx.next().grid, scene);
  for (let i = 0; i < 12; i++) {
    const current = renderScene(tx.next().grid, scene);
    rx.processFrame(tearFrames(previous, current, 0.3 + 0.4 * ((i * 7) % 5) / 5));
    previous = current;
  }

  const s = rx.stats;
  const band = (100 * s.bandsPassed) / s.bandsTried;
  const chroma = (100 * s.chromaPassed) / s.chromaTried;
  assert.ok(band > 60, `band ${band.toFixed(0)}%`);
  assert.ok(chroma < band, `chroma ${chroma.toFixed(0)}% vs band ${band.toFixed(0)}%`);
});

test("the expected marker ratio is fixed by the format, not by distance", () => {
  // Three 6x6 markers and one 4x4, four cells in from each edge.
  assert.ok(Math.abs(expectedMarkerRatio(48) - 0.139) < 0.005);
  assert.ok(Math.abs(expectedMarkerRatio(64) - 0.1) < 0.005);
});

test("a quad that is not square enough is refused", () => {
  const sliver = [
    { x: 0, y: 0, area: 900 },
    { x: 400, y: 0, area: 900 },
    { x: 400, y: 20, area: 900 },
    { x: 0, y: 20, area: 900 },
  ];
  assert.equal(orderCorners(sliver), null);
});

test("corners come back in TL, TR, BR, BL order", () => {
  // A 220 px quad implies roughly 30 px markers at 48x48, which is what the
  // ratio test checks; areas that do not match the span are not a code.
  const square = [
    { x: 100, y: 320, area: 900 }, // BL
    { x: 320, y: 100, area: 900 }, // TR
    { x: 100, y: 100, area: 900 }, // TL
    { x: 320, y: 320, area: 400 }, // BR
  ];
  const ordered = orderCorners(square);
  assert.ok(ordered);
  assert.deepEqual(
    ordered.map((b) => [b.x, b.y]),
    [
      [100, 100],
      [320, 100],
      [320, 320],
      [100, 320],
    ],
  );
});

test("candidates are ranked, so a wrong first guess is not fatal", () => {
  const real = [
    { x: 100, y: 100, area: 900 },
    { x: 320, y: 100, area: 900 },
    { x: 320, y: 320, area: 400 },
    { x: 100, y: 320, area: 900 },
  ];
  const decoys = [
    { x: 40, y: 40, area: 750 },
    { x: 900, y: 40, area: 750 },
    { x: 900, y: 500, area: 750 },
    { x: 40, y: 500, area: 750 },
  ];

  const quads = findMarkerQuads([...decoys, ...real], 4, expectedMarkerRatio(48));
  assert.ok(quads.length >= 1);
  // The decoys span far too much frame for their size to be markers of a
  // 48-cell grid, so the real quad must rank first.
  assert.deepEqual(new Set(quads[0].map((b) => b.x)), new Set([100, 320]));
});
