import { test } from "node:test";
import assert from "node:assert/strict";

import { crc32 } from "../src/core/crc.ts";
import { geometry } from "../src/core/geometry.ts";
import { FrameType, type BandFrame } from "../src/core/framing.ts";
import { packManifest, type Manifest } from "../src/core/manifest.ts";
import { LTEncoder } from "../src/core/lt.ts";
import { SessionRouter, assignNonces, deriveSessionId, shortId } from "../src/core/session.ts";
import { randomBytes } from "./helpers.ts";

const g = geometry(64);

interface Fixture {
  readonly payload: Uint8Array;
  readonly manifest: Manifest;
  readonly encoder: LTEncoder;
  readonly sid8: number;
}

function fixture(name: string, bytes: number, seed: number, nonce = 0): Fixture {
  const payload = randomBytes(bytes, seed);
  const encoder = new LTEncoder(payload, g.symBytes);
  const sessionId = deriveSessionId(encoder.fileCRC, encoder.total, name, nonce);
  return build(payload, encoder, sessionId, name);
}

/** A fixture engineered to collide with `targetSid8`, for the one case the
 *  8-bit short id cannot disambiguate on its own. */
function collidingFixture(
  name: string,
  bytes: number,
  seed: number,
  targetSid8: number,
): Fixture {
  const payload = randomBytes(bytes, seed);
  const fileCRC = crc32(payload);
  for (let nonce = 0; nonce < 100000; nonce++) {
    const id = deriveSessionId(fileCRC, payload.length, name, nonce);
    if (shortId(id) === targetSid8) {
      return build(payload, new LTEncoder(payload, g.symBytes), id, name);
    }
  }
  throw new Error("no colliding nonce found");
}

function build(
  payload: Uint8Array,
  encoder: LTEncoder,
  sessionId: number,
  name: string,
): Fixture {
  return {
    payload,
    encoder,
    sid8: shortId(sessionId),
    manifest: {
      sessionId,
      total: encoder.total,
      K: encoder.K,
      symBytes: g.symBytes,
      fileCRC: encoder.fileCRC,
      name,
    },
  };
}

const manifestFrame = (f: Fixture): BandFrame => ({
  type: FrameType.Manifest,
  band: 0,
  esi: 0,
  sid8: f.sid8,
  payload: packManifest(f.manifest, g.symBytes),
});

const dataFrame = (f: Fixture): BandFrame => {
  const s = f.encoder.next();
  return { type: FrameType.Data, band: 1, esi: s.esi, sid8: f.sid8, payload: s.data };
};

test("session ids are content-derived and stable", () => {
  const a = deriveSessionId(0x11223344, 5000, "a.bin");
  const b = deriveSessionId(0x11223344, 5000, "a.bin");
  assert.equal(a, b, "same content must yield the same id");

  assert.notEqual(a, deriveSessionId(0x11223344, 5000, "b.bin"));
  assert.notEqual(a, deriveSessionId(0x11223345, 5000, "a.bin"));
  assert.notEqual(a, deriveSessionId(0x11223344, 5001, "a.bin"));
  assert.notEqual(a, deriveSessionId(0x11223344, 5000, "a.bin", 1));
});

test("assignNonces gives every object in a playlist a distinct short id", () => {
  const objects = Array.from({ length: 40 }, (_, i) => ({
    fileCRC: crc32(new Uint8Array([i])),
    total: 1000 + i,
    name: `object-${i}.bin`,
  }));

  const nonces = assignNonces(objects);
  const shorts = objects.map((o, i) => shortId(deriveSessionId(o.fileCRC, o.total, o.name, nonces[i])));
  assert.equal(new Set(shorts).size, objects.length, "short ids must not collide within a set");
});

test("a mid-transfer file switch does not corrupt the first file", () => {
  const first = fixture("first.bin", 3000, 101);
  const second = fixture("second.bin", 3000, 202);
  assert.notEqual(first.sid8, second.sid8, "fixture precondition: distinct short ids");

  const router = new SessionRouter();
  router.ingest(manifestFrame(first), g.symBytes);

  // Partially transfer the first file, short of completion.
  for (let i = 0; i < 20; i++) router.ingest(dataFrame(first), g.symBytes);
  const firstSession = router.get(first.manifest.sessionId);
  assert.ok(firstSession);
  assert.ok(!firstSession.decoder.complete, "fixture precondition: still in progress");
  const absorbedBefore = firstSession.decoder.distinctSeen;
  const recoveredBefore = firstSession.decoder.have;
  assert.equal(absorbedBefore, 20);

  // The transmitter switches files. Symbols now belong to a different object.
  router.ingest(manifestFrame(second), g.symBytes);
  for (let i = 0; i < 20; i++) router.ingest(dataFrame(second), g.symBytes);

  // The first session must be untouched, not fed foreign symbols. Before the
  // session layer existed, these symbols were XOR-ed into the first file's
  // blocks and it could never converge.
  assert.equal(firstSession.decoder.distinctSeen, absorbedBefore);
  assert.equal(firstSession.decoder.have, recoveredBefore);
  assert.equal(router.activeSession?.manifest.name, "second.bin");

  // And the first file still finishes correctly once its own symbols resume.
  router.ingest(manifestFrame(first), g.symBytes);
  while (!firstSession.decoder.complete) router.ingest(dataFrame(first), g.symBytes);
  const { bytes, ok } = firstSession.decoder.verify();
  assert.ok(ok);
  assert.deepEqual(bytes, first.payload);
});

test("a manifest for a new session reports the switch", () => {
  const first = fixture("a.bin", 2000, 11);
  const second = fixture("b.bin", 2000, 22);
  const router = new SessionRouter();

  const r1 = router.ingest(manifestFrame(first), g.symBytes);
  assert.equal(r1.kind, "manifest");
  assert.equal(r1.kind === "manifest" && r1.switched, true);

  const r2 = router.ingest(manifestFrame(first), g.symBytes);
  assert.equal(r2.kind === "manifest" && r2.switched, false, "repeat is not a switch");

  const r3 = router.ingest(manifestFrame(second), g.symBytes);
  assert.equal(r3.kind === "manifest" && r3.switched, true);
});

test("a looping playlist resumes a partly received object on the next pass", () => {
  const a = fixture("a.bin", 6000, 55);
  const b = fixture("b.bin", 2000, 66);
  const router = new SessionRouter();

  // First pass over A: take some symbols, then move on.
  router.ingest(manifestFrame(a), g.symBytes);
  for (let i = 0; i < 30; i++) router.ingest(dataFrame(a), g.symBytes);
  const session = router.get(a.manifest.sessionId);
  assert.ok(session);
  const afterFirstPass = session.decoder.distinctSeen;
  assert.equal(afterFirstPass, 30);
  assert.ok(!session.decoder.complete, "fixture precondition: A is unfinished");

  // B plays in between.
  router.ingest(manifestFrame(b), g.symBytes);
  for (let i = 0; i < 30; i++) router.ingest(dataFrame(b), g.symBytes);

  // A comes round again. Because the id is content-derived it is the same
  // session, and accumulated progress carries over.
  router.ingest(manifestFrame(a), g.symBytes);
  const resumed = router.get(a.manifest.sessionId);
  assert.equal(resumed, session, "same object must map to the same session");

  while (!session.decoder.complete) router.ingest(dataFrame(a), g.symBytes);
  const { bytes, ok } = session.decoder.verify();
  assert.ok(ok);
  assert.deepEqual(bytes, a.payload);
  assert.ok(
    session.decoder.distinctSeen > afterFirstPass,
    "the second pass should build on the first, not restart it",
  );
});

test("symbols arriving before the manifest are buffered and then absorbed", () => {
  const f = fixture("late.bin", 2500, 77);
  const router = new SessionRouter();

  for (let i = 0; i < 10; i++) {
    const r = router.ingest(dataFrame(f), g.symBytes);
    assert.equal(r.kind, "buffered");
  }

  const r = router.ingest(manifestFrame(f), g.symBytes);
  assert.equal(r.kind, "manifest");
  const session = router.get(f.manifest.sessionId);
  assert.ok(session);
  assert.equal(session.decoder.distinctSeen, 10, "buffered symbols should have been drained");
});

test("a short-id collision discards the contaminated session rather than trusting it", () => {
  const owner = fixture("owner.bin", 2500, 99);
  const intruder = collidingFixture("intruder.bin", 2500, 88, owner.sid8);
  assert.equal(intruder.sid8, owner.sid8, "fixture precondition: ids collide");
  assert.notEqual(intruder.manifest.sessionId, owner.manifest.sessionId);

  const router = new SessionRouter();
  router.ingest(manifestFrame(owner), g.symBytes);
  for (let i = 0; i < 20; i++) router.ingest(dataFrame(owner), g.symBytes);
  assert.ok(router.get(owner.manifest.sessionId));

  // The intruder's data frames reached owner's decoder before its manifest
  // arrived, because they carry the same short id. Owner is now poisoned.
  for (let i = 0; i < 3; i++) router.ingest(dataFrame(intruder), g.symBytes);
  router.ingest(manifestFrame(intruder), g.symBytes);

  assert.equal(
    router.get(owner.manifest.sessionId),
    undefined,
    "the contaminated session must be dropped, not carried forward",
  );
  const session = router.get(intruder.manifest.sessionId);
  assert.ok(session);
  assert.equal(session.decoder.distinctSeen, 0, "the new session starts clean");
});

test("a manifest whose short id disagrees with its session id is refused", () => {
  const f = fixture("forged.bin", 2000, 71);
  const router = new SessionRouter();
  const forged: BandFrame = { ...manifestFrame(f), sid8: (f.sid8 + 1) & 0xff };

  const r = router.ingest(forged, g.symBytes);
  assert.equal(r.kind, "ignored");
  assert.equal(r.kind === "ignored" && r.reason, "sid-mismatch");
  assert.equal(router.get(f.manifest.sessionId), undefined);
});

test("a manifest whose symbol size disagrees with our geometry is refused", () => {
  const f = fixture("mismatch.bin", 2000, 44);
  const router = new SessionRouter();
  const r = router.ingest(manifestFrame(f), geometry(80).symBytes);
  assert.equal(r.kind, "ignored");
  assert.equal(r.kind === "ignored" && r.reason, "geometry-mismatch");
});

test("close frames mark the session as closing", () => {
  const f = fixture("closing.bin", 2000, 123);
  const router = new SessionRouter();
  router.ingest(manifestFrame(f), g.symBytes);

  const payload = new Uint8Array(g.symBytes);
  payload[0] = 0;
  payload[1] = 12;
  const r = router.ingest(
    { type: FrameType.Close, band: 0, esi: 0, sid8: f.sid8, payload },
    g.symBytes,
  );
  assert.equal(r.kind, "closing");
  assert.equal(r.kind === "closing" && r.framesRemaining, 12);
  assert.equal(router.get(f.manifest.sessionId)?.closingIn, 12);
});

test("the session cache evicts the least recently used object", () => {
  const router = new SessionRouter(2);
  const a = fixture("a.bin", 1000, 1);
  const b = fixture("b.bin", 1000, 2);
  const c = fixture("c.bin", 1000, 3);

  router.ingest(manifestFrame(a), g.symBytes);
  router.ingest(manifestFrame(b), g.symBytes);
  router.ingest(manifestFrame(c), g.symBytes);

  assert.equal(router.get(a.manifest.sessionId), undefined, "oldest should be evicted");
  assert.ok(router.get(b.manifest.sessionId));
  assert.ok(router.get(c.manifest.sessionId));
});
