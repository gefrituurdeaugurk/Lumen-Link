# Lumen-Link

Data transfer through visual imagery — rateless optical file transfer over a
four-colour grid.

One display feeds any number of receivers with no back channel, no pairing,
and no retransmission requests. Luma carries the base layer, the blue–yellow
axis carries an enhancement layer, and an LT fountain runs over both: any
K(1+ε) distinct symbols reconstruct the payload, so *which* ones you catch
does not matter.

**[SPEC.md](SPEC.md)** is the wire specification. **[index.html](index.html)**
is the built demo — open it directly, no server required.

## Try it

```bash
npm install
npm run build     # bundles the demo into index.html
npm test          # typecheck + 34 tests
npm run serve     # build and serve on :8080
```

Open `index.html`, hit **Start transmit**, then **Use loopback**. Two things
worth doing:

- **Swap payload** partway through a transfer. The receiver reports the new
  object rather than mixing the two, and each file keeps its own progress —
  swap back and a partly received one resumes where it left off.
- Drag **Green ambient** up. Blue-axis separation collapses, the enhancement
  layer drops out on its own, and the base layer keeps converging.

Camera capture is often blocked in a sandboxed frame; save the page and open
it from disk if the camera button errors.

## Layout

```
src/core/      protocol — codec, framing, sessions, manifest. No DOM.
src/vision/    capture pipeline — markers, homography, colour decisions.
src/receiver.ts  the two, wired together
src/demo/      presentation only: canvas, UI, loopback simulator
test/          34 tests, including a full optical loop with no browser
```

The split is load-bearing: `core` and `vision` never touch the DOM, so the
whole codec — including marker detection, geometry resolution and colour
decoding — runs headlessly in `node --test` against rasterised frames.

Built with TypeScript 7 (`tsc`, the native compiler) and esbuild. The demo is
bundled inline into a single self-contained `index.html` so it keeps working
from a `file://` URL.

## What version 2 changed

Version 1 had no session identity. A receiver could not tell one file from
the next: `ingest()` discarded every manifest after the first, so a
mid-transfer file switch fed foreign symbols into the live decoder and the
transfer either wedged or failed its checksum with no path to recovery.

The fix is identity on every symbol, not begin/end markers — a broadcast
fountain has no guarantee that any receiver observes a boundary. See
[SPEC.md §1](SPEC.md) for the reasoning and §4 for the format.

Also in this version:

- **Session ids cost zero payload.** The 8-bit `sid8` costs 24 bits after
  triple repetition, which is exactly the slack the old 72-bit header left.
  All three standard grids now pack their band capacity exactly.
- **Content-derived ids** make loop accumulation free: a playlist cycling
  A → B → C → A lets a receiver finish A on the second pass.
- **The enhancement layer works.** It never decoded in v1 — black and white
  sit within a few levels of each other on the blue/yellow difference yet
  carry opposite blue bits, so a single threshold across all four colours is
  unreadable. Conditioning the decision on the recovered luma bit fixes it:
  measured 27 → 21 frames for the same payload.
- **Band whitening** keeps the duty cycle near 50% regardless of payload
  entropy, and doubles as a cross-check on geometry.
- **Marker detection** now requires a bright quiet ring, without which an
  isolated dark cell in the band region is indistinguishable from a marker.
- **Bounded sizes.** `K ≤ 8192` keeps at least 8× fountain overhead against
  the 16-bit ESI space; larger payloads segment across sessions.

## Not implemented

CRC-32 is not a MAC. Anyone who can display a grid can transmit a session a
receiver will accept. The manifest reserves a `SIGNATURE` field, but its
format is unspecified and nothing produces or checks one — do not treat a
received payload as authenticated. See [SPEC.md §9](SPEC.md).
