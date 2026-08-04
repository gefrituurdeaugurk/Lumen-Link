/**
 * Demo wiring. Presentation only: every protocol decision lives in
 * `src/core` and `src/vision`, and this file just moves values between the
 * DOM and those modules.
 */

import { geometry } from "../core/geometry.ts";
import { Transmitter } from "../core/transmitter.ts";
import { Receiver } from "../receiver.ts";
import { CHROMA_FLOOR } from "../vision/decode.ts";
import type { Session } from "../core/session.ts";
import { GridRenderer, drawLockOverlay, drawScope, SCOPE_SLOTS, type ScopeEntry } from "./render.ts";
import { LoopbackCamera } from "./loopback.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const DEMO_PAYLOADS: readonly { name: string; text: string }[] = [
  {
    name: "fountain.txt",
    text:
      "Lumen Link demo payload. A rateless code means the receiver never asks for a " +
      "retransmission: it just keeps collecting distinct symbols until it has enough, and any " +
      "symbol is as useful as any other. That property is what makes one screen able to feed " +
      "three hundred phones at once with no back channel and no network.",
  },
  {
    name: "sessions.txt",
    text:
      "This is a different file. Because every symbol carries a session id, the receiver can " +
      "tell it apart from the previous one without ever seeing a begin or end marker. Swap back " +
      "and forth: each file keeps its own progress, and a partly received one resumes where it " +
      "left off rather than starting over.",
  },
];

// ---------------------------------------------------------------- transmit

const txCanvas = $<HTMLCanvasElement>("txCanvas");
const renderer = new GridRenderer(txCanvas);

let tx: Transmitter | null = null;
let txTimer: number | null = null;
let txFrames = 0;
let txBytes = 0;
let txStart = 0;
let payload = new TextEncoder().encode(DEMO_PAYLOADS[0].text);
let payloadName = DEMO_PAYLOADS[0].name;
let demoIndex = 0;

function buildTransmitter(): void {
  const grid = Number($<HTMLSelectElement>("gridSel").value);
  tx = new Transmitter(payload, {
    grid,
    name: payloadName,
    enhancement: $<HTMLSelectElement>("chromaSel").value === "1",
  });

  renderer.resize(grid);
  $("txFile").textContent = payloadName;
  $("txSession").textContent = tx.sessionId.toString(16).padStart(8, "0");
  $("txK").textContent = String(tx.encoder.K);
  $("txSym").innerHTML = `${tx.geometry.symBytes}<small> B</small>`;

  txFrames = 0;
  txBytes = 0;
  txStart = performance.now();
  rebuildReceiver(grid);
  drawFrame();
}

function drawFrame(): void {
  if (!tx) return;
  const { grid, stats } = tx.next();
  renderer.draw(grid);

  txFrames++;
  txBytes += stats.symbols * tx.geometry.symBytes;
  const elapsed = (performance.now() - txStart) / 1000;
  if (elapsed > 0.6) {
    $("txRate").innerHTML = `${Math.round(txBytes / elapsed)}<small> B/s</small>`;
  }
}

function setTransmitting(on: boolean): void {
  if (txTimer !== null) {
    clearInterval(txTimer);
    txTimer = null;
  }
  if (on) {
    const fps = Number($<HTMLSelectElement>("fpsSel").value);
    txStart = performance.now();
    txFrames = 0;
    txBytes = 0;
    txTimer = window.setInterval(drawFrame, 1000 / fps);
    $("txBtn").textContent = "Pause";
    $("txState").textContent = `transmitting @ ${fps} fps`;
  } else {
    $("txBtn").textContent = "Start transmit";
    $("txState").textContent = "paused";
  }
}

$("txBtn").onclick = () => setTransmitting(txTimer === null);

$("swapBtn").onclick = () => {
  demoIndex = (demoIndex + 1) % DEMO_PAYLOADS.length;
  const next = DEMO_PAYLOADS[demoIndex];
  payload = new TextEncoder().encode(next.text);
  payloadName = next.name;
  $<HTMLInputElement>("fileIn").value = "";
  buildTransmitter();
};

$<HTMLInputElement>("fileIn").onchange = (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  void file.arrayBuffer().then((buf) => {
    payload = new Uint8Array(buf);
    payloadName = file.name;
    buildTransmitter();
  });
};

for (const id of ["gridSel", "chromaSel"]) {
  $<HTMLSelectElement>(id).onchange = () => buildTransmitter();
}
$<HTMLSelectElement>("fpsSel").onchange = () => {
  if (txTimer !== null) setTransmitting(true);
};

// ----------------------------------------------------------------- receive

const rxVideo = $<HTMLVideoElement>("rxVideo");
const rxSim = $<HTMLCanvasElement>("rxSim");
const rxOverlay = $<HTMLCanvasElement>("rxOverlay");
const scope = $<HTMLCanvasElement>("scope");
const loopback = new LoopbackCamera(rxSim);

const capture = document.createElement("canvas");
const captureCtx = capture.getContext("2d", { willReadFrequently: true })!;

let rx: Receiver | null = null;
let rafId: number | null = null;
let mode: "cam" | "loop" | null = null;
let stream: MediaStream | null = null;
let rxStart = 0;
let history: ScopeEntry[] = [];

function rebuildReceiver(grid: number): void {
  rx = new Receiver(geometry(grid));
  history = [];
  rxStart = performance.now();
  $("doneBox").style.display = "none";
  $("pFill").style.width = "0%";
  $("pTxt").textContent = "no manifest yet";
  $("pPct").textContent = "";
  drawScope(scope, history);
}

function simParams() {
  return {
    noise: Number($<HTMLInputElement>("simNoise").value),
    defocus: Number($<HTMLInputElement>("simBlur").value) / 10,
    greenAmbient: Number($<HTMLInputElement>("simTint").value) / 100,
    skew: Number($<HTMLInputElement>("simRot").value),
  };
}

function tick(): void {
  rafId = requestAnimationFrame(tick);
  if (!rx || !tx) return;

  let source: CanvasImageSource;
  let sw: number;
  let sh: number;

  if (mode === "cam") {
    if (rxVideo.readyState < 2) return;
    source = rxVideo;
    sw = rxVideo.videoWidth;
    sh = rxVideo.videoHeight;
  } else {
    loopback.render(txCanvas, simParams());
    source = rxSim;
    sw = rxSim.width;
    sh = rxSim.height;
  }

  const width = 480;
  const height = Math.round((width * sh) / sw);
  capture.width = width;
  capture.height = height;
  captureCtx.drawImage(source, 0, 0, width, height);
  const image = captureCtx.getImageData(0, 0, width, height);

  const outcome = rx.processFrame(image);

  history.push({
    bandsPassed: outcome.bandsPassed,
    bandsTried: outcome.bandsTried,
    chromaPassed: outcome.chromaPassed,
    chromaTried: outcome.chromaTried,
  });
  if (history.length > SCOPE_SLOTS) history.shift();

  drawLockOverlay(rxOverlay, outcome.homography, tx.geometry.W, width, height);
  rxOverlay.style.width = "100%";

  if (outcome.switchedTo) {
    $("rxState").textContent = `new object: ${outcome.switchedTo.manifest.name}`;
  }
  if (outcome.completed) present(outcome.completed);
  if (rx.stats.framesSeen % 3 === 0) updateMeters();
}

function updateMeters(): void {
  if (!rx) return;
  const s = rx.stats;

  $("mLock").textContent = s.framesSeen
    ? `${Math.round((100 * s.framesLocked) / s.framesSeen)}%`
    : "–";

  // Band and chroma read over the scope window rather than the whole
  // session. Lifetime averages hide the thing worth watching: the
  // enhancement layer dropping out while the base layer keeps converging.
  let bandsTried = 0;
  let bandsPassed = 0;
  let chromaTried = 0;
  let chromaPassed = 0;
  for (const e of history) {
    bandsTried += e.bandsTried;
    bandsPassed += e.bandsPassed;
    chromaTried += e.chromaTried;
    chromaPassed += e.chromaPassed;
  }

  $("mBand").innerHTML = bandsTried
    ? `${Math.round((100 * bandsPassed) / bandsTried)}<small> %</small>`
    : "–<small> %</small>";
  $("mChroma").innerHTML = chromaTried
    ? `${Math.round((100 * chromaPassed) / chromaTried)}<small> %</small>`
    : "off";

  const elapsed = (performance.now() - rxStart) / 1000;
  $("mRate").innerHTML =
    elapsed > 1 ? `${Math.round(s.bytesAccepted / elapsed)}<small> B/s</small>` : "–<small> B/s</small>";

  $("sepTxt").textContent =
    `Δ ${s.separation.toFixed(1)}` + (s.separation > CHROMA_FLOOR ? "  (usable)" : "  (below floor)");

  const session = rx.activeSession;
  if (session) {
    const pct = (100 * session.decoder.have) / session.decoder.K;
    $("pFill").style.width = `${pct.toFixed(1)}%`;
    $("pFill").className = "fill" + (s.chromaPassed > 0 ? " blue" : "");
    $("pTxt").textContent =
      `${session.manifest.name}  ·  ${session.decoder.have} / ${session.decoder.K} blocks` +
      (session.closingIn !== null ? `  ·  closing in ${session.closingIn}` : "");
    $("pPct").textContent = `${pct.toFixed(0)}%`;
  }

  drawScope(scope, history);
}

function present(session: Session): void {
  if (!rx) return;
  const { bytes, ok } = session.decoder.verify();
  const elapsed = ((performance.now() - rxStart) / 1000).toFixed(1);

  $("doneBox").style.display = "flex";
  $("doneName").textContent =
    (ok ? "✓ " : "✗ checksum mismatch: ") +
    `${session.manifest.name}  ·  ${session.decoder.total} bytes  ·  ` +
    `${rx.stats.framesSeen} frames  ·  ${elapsed} s`;

  $("dlBtn").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart]));
    a.download = session.manifest.name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function startReceive(next: "cam" | "loop"): void {
  mode = next;
  rebuildReceiver(Number($<HTMLSelectElement>("gridSel").value));
  rxVideo.style.display = next === "cam" ? "block" : "none";
  rxSim.style.display = next === "cam" ? "none" : "block";
  $("simRow").style.display = next === "cam" ? "none" : "flex";
  $<HTMLButtonElement>("rxStop").disabled = false;
  $("rxState").textContent = next === "cam" ? "camera live" : "loopback";
  if (rafId === null) tick();
}

function stopReceive(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  $<HTMLButtonElement>("rxStop").disabled = true;
  $("rxState").textContent = "stopped";
}

$("camBtn").onclick = async () => {
  const err = $("rxErr");
  err.style.display = "none";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 960 } },
    });
    rxVideo.srcObject = stream;
    await rxVideo.play();
    startReceive("cam");
  } catch (e) {
    const name = e instanceof Error ? e.name : "unknown error";
    err.textContent =
      `Camera unavailable here (${name}). Save this page and open it from disk, ` +
      `or use loopback to exercise the codec.`;
    err.style.display = "block";
  }
};

$("loopBtn").onclick = () => startReceive("loop");
$("rxStop").onclick = stopReceive;

for (const [input, label] of [
  ["simNoise", "vNoise"],
  ["simBlur", "vBlur"],
  ["simTint", "vTint"],
  ["simRot", "vRot"],
] as const) {
  const el = $<HTMLInputElement>(input);
  const update = () => {
    $(label).textContent = input === "simBlur" ? (Number(el.value) / 10).toFixed(1) : el.value;
  };
  el.oninput = update;
  update();
}

buildTransmitter();
