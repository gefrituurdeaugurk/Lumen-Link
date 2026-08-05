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
npm test          # typecheck + 79 tests
npm run serve     # build and serve on :8080
npm run phone     # build, serve, and open a public HTTPS tunnel
```

Open `index.html`, hit **Start transmit**, then **Use loopback**. Two things
worth doing:

- **Swap payload** partway through a transfer. The receiver reports the new
  object rather than mixing the two, and each file keeps its own progress —
  swap back and a partly received one resumes where it left off.
- Drag **Green ambient** up. Blue-axis separation collapses, the enhancement
  layer drops out on its own, and the base layer keeps converging.
- Switch **Enhancement layer** off. The grid collapses to black and white:
  one symbol per frame cheaper, ~50% more luma margin. See below.

## Monochrome mode

Setting `enhancement: false` on the transmitter drops the blue plane and runs
the band region in black and white alone. It needs no wire change and no
receiver change — a symbol that was never sent looks exactly like one the
receiver missed, which a fountain handles by design.

The trade is better than "half the bits": the blue plane carries **one**
symbol at 2×2 pitch against four luma bands, so dropping it costs a fifth of
the frame. What it buys is margin. Palette index is `luma + 2 × blue`, so
blue sits at luma ≈ 56 against a threshold of ≈ 135 — the worst-case luma
margin in four-colour mode is ~79 levels. With only black and white on the
grid it is ~120. In the headless pipeline that is the difference between
failing and converging at a noise amplitude of 190.

The margin only materialises if the blue plane **mirrors** luma. Forcing it to
a constant gives blue/white or black/yellow, either of which leaves a mid-luma
colour on the grid and yields no gain at all. See [SPEC.md §2.5](SPEC.md).

Worth reaching for on long throws, under coloured ambient, on monochrome or
e-ink panels, and for grids that will be screenshotted — JPEG 4:2:0 chroma
subsampling wrecks the blue plane while luma survives.

Camera capture needs a secure context, and a plain `http://` LAN address is
not one — `navigator.mediaDevices` is simply absent there, and on iOS a
self-signed certificate does not help either. `npm run phone` builds, serves,
and opens a Cloudflare quick tunnel with a publicly trusted certificate, then
prints the URL to open on the phone. It needs `cloudflared` (`brew install
cloudflared`).

## Layout

```
src/core/      protocol — codec, framing, sessions, manifest. No DOM.
src/vision/    capture pipeline — markers, homography, colour decisions.
src/receiver.ts  the two, wired together
src/demo/      presentation only: canvas, UI, loopback simulator
test/          79 tests, including a full optical loop with no browser
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
- **Corners are ranked, not taken from the frame extremes.** A room is full
  of dark shapes on bright surfaces that pass every marker shape test, and
  picking corners by extremes gives each of them a veto. Candidate quads are
  now scored against the marker-to-span ratio the format fixes — about 0.14
  at 48×48, independent of distance and rotation — and the best few are tried
  until a band reads. On a simulated capture of a screen in a cluttered room,
  lock went from 13% to 100%.
- **Bounded sizes.** `K ≤ 8192` keeps at least 8× fountain overhead against
  the 16-bit ESI space; larger payloads segment across sessions via `SET`,
  each segment its own session, reassembled by `objIndex` and checked against
  a whole-payload CRC.

## Encrypted payloads (optional)

A transmission can be sealed so only key-holders can read it. Encryption is a
payload transform — the grid, framing, whitening, fountain and session routing
stay exactly as they are and stay public:

```ts
const key = generateKey();                       // 32 bytes, distributed out of band
const sealed = await sealPayload(file, { name: "confidential.pdf" }, key, keyId);
const tx = new Transmitter(sealed, { grid: 64, encryption: { suite: 1, keyId } });

// receiver
const opened = await openPayload(session.decoder.verify().bytes, key, keyId);
// → null without the right key
```

Notes on the design, in [SPEC.md §11](SPEC.md):

- **Deterministic (SIV) encryption**, so loop accumulation survives. A random
  per-transmission nonce would change the ciphertext, change the session id,
  and force receivers to restart from zero on every loop pass.
- **Name and content type move inside the envelope.** A public manifest
  announcing `salaries-2026.xlsx` defeats the point; the transmitter throws if
  you try to set them alongside encryption.
- **`fileCRC` covers the ciphertext**, so reassembly is verifiable without the
  key and no checksum of the plaintext is published.
- The `ENCRYPTION` marker is 5 bytes, small enough for even a 48×48 manifest.

## Not implemented

**CRC-32 is not a MAC**, and encryption gives confidentiality, not authenticity
of origin — anyone can still display a grid. The manifest reserves a
`SIGNATURE` field, but its format is unspecified and nothing produces or checks
one. Replay is not addressed; `EXPIRES` inside a sealed envelope is advisory
only. Per-recipient key wrapping (HPKE) is specified as an extension point but
not built. See [SPEC.md §9 and §11.5–11.6](SPEC.md) for what is and is not
covered.
