/**
 * Demo wiring. Presentation only: every protocol decision lives in
 * `src/core` and `src/vision`, and this file just moves values between the
 * DOM and those modules.
 */

import { geometry } from "../core/geometry.ts";
import { SetAssembler, SetTransmitter, segmentCapacity } from "../core/set.ts";
import { Receiver } from "../receiver.ts";
import { CHROMA_FLOOR } from "../vision/decode.ts";
import { CryptoSuite, generateKey, isSupportedSuite } from "../core/crypto.ts";
import { openPayload, sealPayload } from "../core/envelope.ts";
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

let tx: SetTransmitter | null = null;
let txTimer: number | null = null;
let txFrames = 0;
let txBytes = 0;
let txSegment = 0;
let txStart = 0;
let payload = new TextEncoder().encode(DEMO_PAYLOADS[0].text);
let payloadName = DEMO_PAYLOADS[0].name;
let demoIndex = 0;

// A demo key, generated per page load. A real deployment distributes this out
// of band — printed at the door, in an app login, over a prior channel.
const DEMO_KEY = generateKey();
const DECOY_KEY = generateKey();
const DEMO_KEY_ID = 0x10c0de;

const encryptionOn = () => $<HTMLSelectElement>("encSel").value === "1";
const receiverHasKey = () => $<HTMLSelectElement>("keySel").value === "1";

function showTxError(message: string | null): void {
  const el = $("txErr");
  el.textContent = message ?? "";
  el.style.display = message ? "block" : "none";
}

/** Largest payload one session can carry. Anything past this segments across
 *  sessions rather than being refused (SPEC.md §5.4). */
function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/** Returns false and leaves the previous transmitter running if the payload
 *  cannot be built, so a rejected file cannot leave the UI describing an
 *  object that is not on the wire. */
async function buildTransmitter(): Promise<boolean> {
  const grid = Number($<HTMLSelectElement>("gridSel").value);
  const enhancement = $<HTMLSelectElement>("chromaSel").value === "1";

  try {
    if (encryptionOn()) {
      // Seal before the fountain sees it. Name and content type ride inside the
      // envelope, so the public manifest gives them away to nobody.
      const sealed = await sealPayload(payload, { name: payloadName }, DEMO_KEY, DEMO_KEY_ID);
      tx = new SetTransmitter(sealed, {
        grid,
        enhancement,
        encryption: { suite: CryptoSuite.A256SIV_HS256, keyId: DEMO_KEY_ID },
      });
    } else {
      tx = new SetTransmitter(payload, { grid, enhancement, name: payloadName });
    }
  } catch (e) {
    showTxError(e instanceof Error ? e.message : String(e));
    return false;
  }

  showTxError(null);
  renderer.resize(grid);
  const label = encryptionOn() ? `🔒 ${payloadName}` : payloadName;
  $("txFile").textContent =
    tx.objCount > 1
      ? `${label}  ·  ${describeSize(tx.total)} in ${tx.objCount} segments`
      : label;
  $("txSession").textContent = tx.sessionId.toString(16).padStart(8, "0");
  $("txK").textContent = String(tx.encoder.K);
  $("txSym").innerHTML = `${tx.geometry.symBytes}<small> B</small>`;

  txFrames = 0;
  txBytes = 0;
  txSegment = tx.objIndex;
  txStart = performance.now();
  rebuildReceiver(grid);
  drawFrame();
  return true;
}

function drawFrame(): void {
  if (!tx) return;
  const { grid, stats } = tx.next();
  renderer.draw(grid);

  // The set rotates between segments, and each one is its own session.
  if (tx.objIndex !== txSegment) {
    txSegment = tx.objIndex;
    $("txSession").textContent = tx.sessionId.toString(16).padStart(8, "0");
    $("txK").textContent = String(tx.encoder.K);
  }

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
  void buildTransmitter();
};

$<HTMLInputElement>("fileIn").onchange = (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  void file.arrayBuffer().then(async (buf) => {
    const prevPayload = payload;
    const prevName = payloadName;
    payload = new Uint8Array(buf);
    payloadName = file.name;

    if (!(await buildTransmitter())) {
      payload = prevPayload;
      payloadName = prevName;
      input.value = "";
    }
  });
};

for (const id of ["gridSel", "chromaSel", "encSel"]) {
  const select = $<HTMLSelectElement>(id);
  let lastGood = select.value;
  select.onchange = () => {
    void buildTransmitter().then((ok) => {
      if (ok) lastGood = select.value;
      // A smaller grid may not fit the current payload; do not leave the
      // control claiming a setting that was refused.
      else select.value = lastGood;
    });
  };
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
let assembler = new SetAssembler();

function rebuildReceiver(grid: number): void {
  rx = new Receiver(geometry(grid));
  history = [];
  assembler = new SetAssembler();
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

  // The loopback canvas is already small; a real camera is not. Cell pitch in
  // the capture is what buys blur tolerance, and it is the binding constraint
  // on the denser grids: measured on the scene fixture, 80x80 reads 46% of its
  // bands from a 1280-wide capture and 100% from a 1920-wide one, against a
  // blur scaled to match. Decoding costs ~30 ms a frame at 1920, well inside
  // the budget at any frame rate a camera can actually follow.
  const width = mode === "cam" ? Math.min(sw, 1920) : 480;
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
    const set = session.manifest.set;
    const fraction = session.decoder.progress;

    // Per-segment progress reads as a reset every time the transmitter
    // rotates, so a set is measured across the whole object instead.
    const pct = set
      ? (100 * (assembler.completed(set.setId) + fraction)) / set.objCount
      : 100 * fraction;

    $("pFill").style.width = `${pct.toFixed(1)}%`;
    $("pFill").className = "fill" + (s.chromaPassed > 0 ? " blue" : "");
    $("pTxt").textContent =
      `${session.manifest.name}  ·  ` +
      (set ? `segment ${set.objIndex + 1} / ${set.objCount}  ·  ` : "") +
      `${session.decoder.distinctSeen} / ${session.decoder.K} symbols` +
      remainingText(session, pct) +
      (session.closingIn !== null ? `  ·  closing in ${session.closingIn}` : "");
    $("pPct").textContent = `${pct.toFixed(0)}%`;
  }

  drawScope(scope, history);
}

/** Time left at the goodput measured so far. Worth showing because the honest
 *  answer at 64x64 is minutes, and without it a slow bar looks like a stall. */
function remainingText(session: Session, pct: number): string {
  if (!rx || pct <= 0 || pct >= 100) return "";
  const elapsed = (performance.now() - rxStart) / 1000;
  if (elapsed < 5 || rx.stats.bytesAccepted === 0) return "";

  const left = Math.round((elapsed / pct) * (100 - pct));
  if (!Number.isFinite(left)) return "";
  return left > 90
    ? `  ·  ~${Math.round(left / 60)} min left`
    : `  ·  ~${left} s left`;
}

function present(session: Session): void {
  if (!rx) return;
  const { bytes, ok } = session.decoder.verify();
  const elapsed = ((performance.now() - rxStart) / 1000).toFixed(1);
  const stamp = `${session.decoder.total} bytes  ·  ${rx.stats.framesSeen} frames  ·  ${elapsed} s`;

  const box = $("doneBox");
  box.style.display = "flex";

  if (!ok) {
    box.classList.add("sealed");
    $("doneName").textContent = `✗ checksum mismatch: ${session.manifest.name}  ·  ${stamp}`;
    return;
  }

  // A segment on its own is not a file. Hold it until the set is whole, then
  // hand the joined bytes on exactly as a single-session object would be.
  const progress = assembler.add(session.manifest, bytes);
  if (progress) {
    if (!progress.bytes) {
      box.classList.remove("sealed");
      $("doneName").textContent =
        `⋯ ${progress.name}  ·  ${progress.received} / ${progress.count} segments  ·  ${elapsed} s`;
      return;
    }
    if (!progress.verified) {
      box.classList.add("sealed");
      $("doneName").textContent = `✗ set checksum mismatch: ${progress.name}`;
      return;
    }
    const whole = `${progress.bytes.length} bytes  ·  ${progress.count} segments  ·  ${elapsed} s`;
    deliver(progress.bytes, session, whole);
    return;
  }

  deliver(bytes, session, stamp);
}

function deliver(bytes: Uint8Array, session: Session, stamp: string): void {
  const box = $("doneBox");
  const encryption = session.manifest.encryption;
  if (!encryption) {
    box.classList.remove("sealed");
    $("doneName").textContent = `✓ ${session.manifest.name}  ·  ${stamp}`;
    offerDownload(bytes, session.manifest.name);
    return;
  }

  // The suite id came off the wire, so it is not trusted until checked.
  if (!isSupportedSuite(encryption.suite)) {
    box.classList.add("sealed");
    $("doneName").textContent = `🔒 sealed with an unsupported suite (${encryption.suite})`;
    offerDownload(bytes, "sealed.bin");
    return;
  }

  // Reassembly succeeded — the read was perfect. Whether that yields anything
  // is a separate question, answered only by holding the key.
  const key = receiverHasKey() ? DEMO_KEY : DECOY_KEY;
  void openPayload(bytes, key, encryption.keyId, encryption.suite).then((opened) => {
    if (!opened) {
      box.classList.add("sealed");
      $("doneName").textContent =
        `🔒 sealed — no key. Payload reassembled intact (${stamp}), and it is ` +
        `indistinguishable from random without the key.`;
      offerDownload(bytes, "sealed.bin");
      return;
    }
    box.classList.remove("sealed");
    $("doneName").textContent =
      `✓ 🔓 ${opened.metadata.name}  ·  ${opened.bytes.length} bytes decrypted  ·  ${stamp}`;
    offerDownload(opened.bytes, opened.metadata.name);
  });
}

function offerDownload(bytes: Uint8Array, name: string): void {
  $("dlBtn").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart]));
    a.download = name;
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

  // getUserMedia is only exposed in a secure context, so a plain-http LAN
  // address leaves mediaDevices undefined rather than raising a camera error.
  if (!navigator.mediaDevices?.getUserMedia) {
    err.textContent = window.isSecureContext
      ? "This browser exposes no camera API. Use loopback to exercise the codec."
      : `Camera needs a secure context — this page is on ${window.location.protocol}//. ` +
        `Reopen it over https, or on localhost, or save it and open it from disk. ` +
        `Loopback works here regardless.`;
    err.style.display = "block";
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
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

$<HTMLSelectElement>("keySel").onchange = () => {
  if (mode !== null) startReceive(mode);
};

void buildTransmitter();
