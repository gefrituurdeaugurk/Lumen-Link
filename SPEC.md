# Lumen Link wire specification

Version 2 · status: draft

Rateless optical file transfer over a four-colour grid. One display feeds
any number of receivers with no back channel, no pairing, and no
retransmission requests.

Terms: **MUST**, **SHOULD**, and **MAY** follow RFC 2119.

---

## 1. Design premise

Everything below follows from one assumption: **a receiver may start and stop
watching at any moment, and is never in a position to ask for anything.**

That rules out stream framing. A receiver that walks up mid-transfer never
observes a "begin" marker; one that walks away at 97% never observes an
"end". Any rule whose correctness depends on witnessing a boundary is a rule
that late joiners silently violate.

So object boundaries are carried as **identity on every symbol**, not as
delimiters. "A new file began" is inferred the same way by a receiver that
has been watching for ten minutes and one that arrived a frame ago: the
session id changed. End-of-transmission exists (§6) but is strictly
advisory — no receiver may depend on seeing it.

---

## 2. Physical layer

### 2.1 Grid

A frame is a `W × W` cell grid. `W` **MUST** be a multiple of 16. Three
sizes are standard:

| `W` | band rows | band capacity | chroma capacity | symbol payload |
|---|---|---|---|---|
| 48 | 8 | 384 bits | 384 bits | 32 B |
| 64 | 12 | 768 bits | 768 bits | 80 B |
| 80 | 16 | 1280 bits | 1280 bits | 144 B |

Layout by row:

```
rows 0 .. 7          top zone: TL marker, calibration strip, TR marker
rows 8 .. W-9        band region: 4 luma bands of (W-16)/4 rows each
rows W-8 .. W-1      bottom zone: BL marker, BR marker
```

Four independent bands per frame means a rolling-shutter tear costs one
symbol, not the whole frame.

### 2.2 Palette

Each cell carries two independent bits — `luma` on the black/white axis and
`blue` on the blue/yellow axis. Palette index is `luma + 2 × blue`:

| index | luma | blue | colour | RGB |
|---|---|---|---|---|
| 0 | 0 | 0 | black | `#0B0B0F` |
| 1 | 1 | 0 | yellow | `#FFE500` |
| 2 | 0 | 1 | blue | `#1B2CFF` |
| 3 | 1 | 1 | white | `#FFFFFF` |

The luma plane carries four band symbols. The blue plane carries one further
symbol across the whole band region at **2×2 cell pitch** — sensors resolve
chroma far worse than luminance, so the enhancement layer trades resolution
for the spatial averaging it needs.

### 2.3 Registration markers

Three 6×6 markers at TL, TR, BL and one **4×4** marker at BR. The odd size
keys rotation: the smallest-area marker identifies the bottom-right corner,
so orientation is resolved from marker geometry rather than by brute force.

Markers **MUST** be separated from the grid edge by at least one cell of
quiet white field. Receivers use that bright surround to reject band cells
that would otherwise pass a shape filter (§8.1).

### 2.4 Calibration strip

Rows 1–6, columns 9 onward, carry all four palette extremes in the order
**black, blue, yellow, white**, each `floor((W-18)/4)` cells wide. It is
transmitted **every frame**; receivers **MUST NOT** cache calibration across
frames, because auto-exposure and auto white balance move continuously.

### 2.5 Monochrome mode

A transmitter **MAY** drop the enhancement layer and run the band region in
black and white alone. This is transmitter policy, not a format change: it
emits no band `8`, and no signalling is required, because a symbol that was
never sent is indistinguishable from one the receiver failed to catch — which
a fountain already treats as the ordinary case.

When the enhancement layer is dropped, the blue plane across the band region
**MUST** mirror the luma plane, placing every band cell on palette index 0 or
3. Forcing the plane to a constant instead leaves a mid-luma colour on the
grid — blue at index 2, or yellow at index 1 — and keeps the narrow luma
margin the mode exists to widen. Against the §8.3 threshold, measured on the
palette above:

| mode | band-region colours | worst-case luma margin |
|---|---|---|
| four-colour | black, yellow, blue, white | ~79 levels (blue is the limiter) |
| constant blue plane | blue, white | ~79 levels — no gain |
| monochrome (mirrored) | black, white | ~120 levels |

The calibration strip (§2.4) sits outside the band region and **MUST** still
carry all four extremes, so thresholds are derived exactly as in four-colour
mode and no receiver change is needed.

The cost is one symbol per frame out of five, not half the rate — the blue
plane carries a single symbol at 2×2 pitch against four luma bands. In
conditions bad enough to want this mode the receiver is already discarding
that symbol under the §8.3 floor, so the throughput cost approaches zero
exactly where the margin is worth the most.

---

## 3. Band framing

Each readable region carries one framed symbol:

```
[ header × 3 ][ payload ][ crc32 ][ pad ]
    96 bits     8·S bits   32 bits
```

### 3.1 Header

Four bytes, repeated three times, recovered by **majority vote per bit**.
Bursts — a tear, a specular highlight — take out contiguous runs, so three
spaced copies survive what one copy with an ECC would not.

| byte | field | width |
|---|---|---|
| 0 | `type` : `band` | 4 : 4 bits |
| 1 | `esi` high byte | 8 bits |
| 2 | `esi` low byte | 8 bits |
| 3 | `sid8` — low 8 bits of the session id | 8 bits |

`band` values `0..3` are luma bands; `8` is the blue-plane enhancement
layer. Values `4..7` and `9..15` are reserved.

`type` values:

| value | meaning |
|---|---|
| 0 | `DATA` — a fountain symbol |
| 1 | `MANIFEST` — an uncoded session manifest (§5) |
| 2 | `CLOSE` — advisory end-of-fountain (§6) |
| 3–15 | reserved; receivers **MUST** ignore unknown types |

### 3.2 Header cost

The `sid8` field costs 8 bits × 3 repeats = 24 bits. That is exactly the
slack the previous 72-bit header left after rounding symbol payloads down to
an 8-byte multiple, so **session identity costs zero payload at all three
standard grid sizes**. All three now pack their band capacity exactly:

```
96 + 8·S + 32 = band capacity      for S ∈ {32, 80, 144}
```

Implementations targeting non-standard `W` **MUST** pad any remainder.

### 3.3 CRC

CRC-32 (IEEE 802.3, reflected, polynomial `0xEDB88320`) over the
**un-repeated header followed by the payload**. A band failing its CRC
**MUST** be discarded. This is what makes it safe to speculatively try
several orientations against one frame.

### 3.4 Whitening

After framing, the entire band plane is XOR-ed with a deterministic mask
keyed by **band index alone**. A low-entropy payload (ASCII, sparse binary)
would otherwise produce visible structure and a duty cycle far from 50%.

Keying on band index rather than on the header is deliberate: the receiver
knows which region it is reading before it has parsed anything, so
un-whitening never depends on a prior header parse. It also means a band
read with the wrong index cannot decode — a free cross-check on geometry,
and the reason the enhancement layer uses its own band id (`8`) rather than
reusing `0`.

Whitening is **not** encryption. It provides no confidentiality.

---

## 4. Session identity

### 4.1 Derivation

```
sessionId = crc32( u32be(fileCRC) ‖ u32be(total) ‖ u32be(nonce) ‖ utf8(name) )
sid8      = sessionId & 0xFF
```

Ids are **content-derived, not sequential**. Two consequences:

- **Loop accumulation.** A playlist cycling A → B → C → A reuses A's id on
  the second pass. A receiver that caught 60% of A the first time finishes
  it the second, for free — any symbol is as good as any other, including
  one from eight minutes ago.
- **Multi-transmitter redundancy.** Two screens showing the same object
  produce the same id, so a receiver can accumulate from both.

### 4.2 The two-tier id

The full 32-bit id lives in the manifest and is authoritative. The 8-bit
`sid8` in every band header is a **fast reject**: a receiver can route or
discard a symbol without a manifest in hand.

A manifest whose `sid8` is not the low byte of its declared `sessionId`
**MUST** be rejected.

### 4.3 Short-id collisions

Two objects in one playlist could collide on 8 bits. The transmitter knows
its whole playlist and **SHOULD** assign per-object `nonce` values so that
no two objects in a loop share a `sid8`. This removes the ambiguity
entirely, at zero runtime cost.

When a collision does occur, a receiver **MUST** treat the previously bound
session as contaminated and discard it (§8.4). Between a switch and the new
object's first manifest, the new object's symbols carry the old binding and
are routed into the old decoder; nothing downstream catches that, because
those symbols pass their band CRC honestly. Only the whole-file CRC would,
and by then the transfer is wasted.

---

## 5. Manifest

Sent uncoded on band 0 every **4 frames**, so a fresh receiver syncs in
under a second at 5 fps. Fixed 18-byte core, then TLV extensions.

### 5.1 Core

| offset | field | type |
|---|---|---|
| 0 | magic `0x4C` (`'L'`) | u8 |
| 1 | version (`2`) | u8 |
| 2–5 | `sessionId` | u32be |
| 6–9 | `total` — payload length in bytes | u32be |
| 10–11 | `K` — source blocks | u16be |
| 12–13 | `symBytes` | u16be |
| 14–17 | `fileCRC` | u32be |

### 5.2 Extensions

`tag:u8, len:u8, value[len]`, terminated by tag `0`. Unknown tags **MUST**
be skipped, not treated as an error.

| tag | name | value |
|---|---|---|
| 0 | `END` | — |
| 1 | `NAME` | UTF-8 |
| 2 | `CONTENT_TYPE` | UTF-8 |
| 3 | `SET` | `setId` u32be, `objIndex` u16be, `objCount` u16be |
| 4 | `SIGNATURE` | reserved, see §9 |

Extensions are written in priority order — `SET`, then `NAME`, then
`CONTENT_TYPE` — and dropped whole when they do not fit. `NAME` is truncated
on a UTF-8 boundary rather than dropped. At 48×48 only 14 bytes remain for
extensions, so a full record needs 64×64 or larger.

### 5.3 Validation

A receiver **MUST** reject a manifest whose:

- magic or version does not match,
- `K` is zero or above the §7 ceiling,
- `symBytes` disagrees with the geometry being sampled,
- `total` is inconsistent with `K × symBytes` — specifically, `total` must
  satisfy `(K-1)·symBytes < total ≤ K·symBytes`,
- `sid8` disagrees with `sessionId` (§4.2).

### 5.4 Multi-object sets

`SET` is the collection layer. It is where "this transmission has a
beginning and an end" legitimately lives — at the level of a playlist, not a
byte stream. It also carries payloads larger than one session can (§7):
segment across objects and reassemble by `objIndex`.

---

## 6. End of fountain

A `CLOSE` frame on band 0 carries `framesRemaining` as u16be in the first
two payload bytes.

It is **advisory**. It lets a receiver stuck at 97% report *transmission
ended* rather than spinning forever. Correctness **MUST NOT** depend on it:
plenty of receivers will miss it, and a receiver that never sees one is not
in an error state.

Transmitters **SHOULD** send `CLOSE` for several consecutive frames before
stopping.

---

## 7. Size bounds

`esi` is 16 bits, so a session offers at most **65 536 distinct symbols**.
Past that the space repeats and a decoder that has not converged never will.

Rather than widen the field, the format bounds the payload:

- `K` **MUST NOT** exceed **8192**, giving at least 8× fountain overhead
  against the ESI space. Encoders **MUST** refuse larger payloads.
- At 64×64 that is roughly **640 KB** per session.

Larger payloads segment across sessions via `SET` (§5.4). This is honest
about the medium: 640 KB at the ~4.5 KB/s a 64×64 grid at 12 fps offers is
already well over two minutes.

A receiver that has consumed the full ESI space without converging **MUST**
abandon the session rather than wait.

---

## 8. Receiver behaviour

### 8.1 Marker detection

Threshold (Otsu), flood-fill dark components, then filter on area, extent,
aspect ratio, and fill ratio. Surviving blobs **MUST** additionally be
required to sit in a bright surround: sample the perimeter of the bounding
box expanded by a small fixed pad and require ≥75% bright.

Without that ring test, an isolated dark cell in the band region is
indistinguishable from a marker on shape and area alone.

### 8.2 Orientation

Estimate rotation from marker areas (§2.3), try that first, then fall back
to the remaining rotations. A candidate is accepted when at least one band
passes CRC **and** that band's header `band` field matches the region it was
read from. Receivers **SHOULD** cache the last accepted rotation.

### 8.3 Colour decisions

Luma: one threshold, midway between the mean of the dark calibration pair
(black, blue) and the bright pair (yellow, white).

Chroma: **two** thresholds, selected per cell by that cell's recovered luma
bit.

> This is not optional. On the blue/yellow difference `b − (r+g)/2`, black
> sits at ≈ +4 and white at ≈ 0 — within a few levels of each other — yet
> they carry **opposite** blue bits. A single slice across all four colours
> is unreadable no matter how clean the capture. Conditioning on luma turns
> it into two well-separated decisions: black-vs-blue for dark cells,
> yellow-vs-white for bright ones.

Reported separation **MUST** be the worse of the two pairs, not their
average. Below a floor (16 levels in the reference implementation) the
enhancement layer **SHOULD** be skipped entirely rather than fed noise into
the decoder — the base layer keeps converging on its own.

### 8.4 Session routing

```
MANIFEST  → validate (§5.3); create or resume the session; bind sid8;
            drain symbols buffered under that sid8
DATA      → route by sid8 binding; if unbound, buffer (bounded)
CLOSE     → mark the bound session as closing
```

Buffering rules:

- Symbols under a **never-bound** `sid8` are the ordinary late-joiner case
  and **SHOULD** be drained into the session when its manifest arrives.
- Rebinding a `sid8` to a **different** session **MUST** discard both the
  buffered symbols and the previously bound session (§4.3).

Receivers **SHOULD** keep several sessions warm (4 in the reference
implementation, LRU) so loop accumulation works across a playlist cycle.

### 8.5 Completion

Completion is `K` recovered blocks **and** a matching `fileCRC`. A receiver
**MUST** verify the whole-file CRC before presenting a payload as complete —
it is the only check that catches cross-session contamination.

---

## 9. Security considerations

**CRC-32 is not a MAC.** It detects accidental corruption and nothing else.
Anyone who can display a grid can transmit a session that a receiver will
accept, under any name and content type it likes.

The `SIGNATURE` TLV (tag 4) is reserved for a detached signature over the
manifest core, but **its format is not yet specified and no implementation
produces or checks one**. Until it is, deployments **MUST NOT** treat a
received payload as authenticated, and receivers **SHOULD NOT** act on
`CONTENT_TYPE` in ways that assume trusted input.

Whitening (§3.4) provides no confidentiality; anything requiring it must be
encrypted before being handed to the transmitter.

---

## 10. Compatibility

Version 2 is **not** wire-compatible with version 1: the header grew from 72
to 96 bits, band framing is whitened, and the manifest was restructured.
Version 1 had no session identity at all — a receiver could not tell one
file from the next, and a mid-transfer switch silently corrupted the
in-flight decode.

Forward-compatible extension points: `type` values 3–15, `band` values 4–7
and 9–15, and manifest TLV tags 5+.
