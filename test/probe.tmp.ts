import { geometry } from "../src/core/geometry.ts";
import { Transmitter } from "../src/core/transmitter.ts";
import { Receiver } from "../src/receiver.ts";
import { renderScene, randomBytes, type SceneOptions } from "./helpers.ts";

const room: SceneOptions = { clutter: 6, gradient: 0.35, noise: 20 };

function run(grid: number, opts: SceneOptions, frames = 6) {
  const tx = new Transmitter(randomBytes(3000, 5), { grid, name: "x.bin" });
  const rx = new Receiver(geometry(grid));
  const imgs = [];
  for (let i = 0; i < frames; i++) imgs.push(renderScene(tx.next().grid, { seed: i + 1, ...opts }));
  const t0 = performance.now();
  for (const img of imgs) rx.processFrame(img);
  const ms = (performance.now() - t0) / frames;
  const s = rx.stats;
  return {
    lock: Math.round((100 * s.framesLocked) / s.framesSeen),
    band: s.bandsTried ? Math.round((100 * s.bandsPassed) / s.bandsTried) : 0,
    ms: Math.round(ms),
  };
}

console.log("== decode cost only, code at fill 0.45 ==");
console.log("shape           Mpx   ms/frame");
for (const [label, w, h] of [
  ["1920x1080 wide", 1920, 1080],
  ["1920x3413 tall", 1920, 3413],
  ["1080x1920 tall", 1080, 1920],
  ["1280x720  wide", 1280, 720],
] as const) {
  const r = run(64, { ...room, frameWidth: w, frameHeight: h, fill: 0.45, blur: 1.5 });
  console.log(`${label}  ${((w * h) / 1e6).toFixed(1)}   ${r.ms}`);
}

console.log("\n== how far can pitch fall? tall 1920x3413, blur 1.5 ==");
console.log("grid  fill  px/cell  lock  band");
for (const grid of [48, 64, 80]) {
  for (const fill of [0.12, 0.17, 0.22, 0.3]) {
    const r = run(grid, { ...room, frameWidth: 1920, frameHeight: 3413, fill, blur: 1.5 });
    const pitch = ((1920 * fill) / (grid + 8)).toFixed(1);
    console.log(`${grid}    ${fill}   ${pitch}      ${r.lock}%  ${r.band}%`);
  }
}
