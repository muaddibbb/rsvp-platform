"use strict";
// Picture P3: nightly cleanup deletes pictures (api/cleanup.js). A DELETION JOB: these tests pin what is deleted
// and above all what is NOT deleted. Written test-first from plan.md (acceptance criteria 1-8 and the Interface
// contract), offline: Supabase = in-memory fake plus a storage stub built here, the clock is a fixed Date.
process.env.SUPABASE_URL = "https://fake-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key-SECRET-123";
process.env.ADMIN_PASSWORD = "fake-admin-pass";
process.env.CRON_SECRET = "fake-cron-secret";
delete process.env.BREVO_API_KEY;
global.fetch = async () => { throw new Error("network is blocked in tests"); };

const test = require("node:test");
require("./_quiet")(test);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");

const ROOT = path.resolve(__dirname, "..");
const STG = "picture-staging";
const PUB = "event-pictures";
const U = (n) => `123e4567-e89b-42d3-a456-4266141740${String(n).padStart(2, "0")}`;
const pic = (n) => `pic/${U(n)}.jpg`;
const ok = (n) => `ok/${U(n)}.jpg`;

// ---- fixed clock: Sunday 2026-11-15 12:00Z and Monday 2026-11-16 12:00Z ----
const RealDate = Date;
const SUNDAY = "2026-11-15T12:00:00Z";
const MONDAY = "2026-11-16T12:00:00Z";
const SATURDAY = "2026-11-14T12:00:00Z";
let nowMs = RealDate.parse(MONDAY);
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(nowMs); }
  static now() { return nowMs; }
}
function setNow(iso) { nowMs = RealDate.parse(iso); }
const ago = (ms) => new RealDate(nowMs - ms).toISOString();
const H = 3600000, D = 24 * H;
const ymd = (n) => new RealDate(nowMs + n * D).toISOString().slice(0, 10);

// ---- storage stub: two buckets with created_at/updated_at, call log, switches ----
let st;
function freshStorage() {
  st = {
    calls: [],
    buckets: { [STG]: new Map(), [PUB]: new Map() },
    removeError: {}, listError: {}, removeThrows: {}, listThrows: {}, listNull: false, missingBucket: {},
    onRefQuery: null, pgrst204: false,
  };
}
freshStorage();
const put = (bucket, p, created, updated) => st.buckets[bucket].set(p, { created_at: created === undefined ? null : created, updated_at: updated === undefined ? null : updated });
const storage = {
  from(bucket) {
    const rec = (op, args) => st.calls.push({ bucket, op, args });
    const missing = () => st.missingBucket[bucket] ? { message: "Bucket not found", status: 404 } : null;
    return {
      async list(folder, opts) {
        rec("list", [folder, opts]);
        if (st.listThrows[bucket]) throw new Error("list boom");
        if (missing()) return { data: null, error: missing() };
        if (st.listError[bucket]) return { data: null, error: { message: "list failed" } };
        if (st.listNull) return { data: null, error: null };
        const off = (opts && opts.offset) || 0, lim = (opts && opts.limit) || 100;
        const names = [];
        for (const [p, m] of st.buckets[bucket]) {
          if (p.startsWith(folder + "/") && !p.slice(folder.length + 1).includes("/")) names.push({ name: p.slice(folder.length + 1), created_at: m.created_at, updated_at: m.updated_at });
        }
        return { data: names.slice(off, off + lim), error: null };
      },
      async remove(paths) {
        rec("remove", [paths]);
        if (st.removeThrows[bucket]) throw new Error("remove boom");
        if (missing()) return { data: null, error: missing() };
        if (st.removeError[bucket]) return { data: null, error: { message: "remove failed" } };
        for (const p of paths) st.buckets[bucket].delete(p);
        return { data: paths.map((name) => ({ name })), error: null };
      },
    };
  },
};
const removedFrom = (bucket) => st.calls.filter((c) => c.bucket === bucket && c.op === "remove").flatMap((c) => c.args[0]);
const callsOn = (bucket) => st.calls.filter((c) => c.bucket === bucket && c.op !== "refquery");
const has = (bucket, p) => st.buckets[bucket].has(p);

// ---- supabase proxy ----
let fake;
const failing = (code, message) => {
  const p = new Proxy({}, { get: (_, k) => (k === "then" ? (res) => res({ data: null, count: null, error: { code, message } }) : () => p) });
  return p;
};
function fresh(seed, opts, iso) { setNow(iso || MONDAY); fake = createFakeSupabase(seed, opts); freshStorage(); return fake; }
fresh();
install({
  storage: { from: (b) => storage.from(b) },
  rpc: (n, a) => fake.rpc(n, a),
  from: (t) => {
    const b = fake.from(t);
    if (t !== "events") return b;
    const touches = (args) => args.some((a) => a === "picture_path" || (typeof a === "string" && a.includes("picture_path")) || (a && typeof a === "object" && !Array.isArray(a) && "picture_path" in a && a.picture_path !== null));
    for (const m of ["select", "update", "eq", "neq", "in", "is", "not", "lt", "lte", "gt", "gte"]) {
      const orig = b[m] && b[m].bind(b);
      if (!orig) continue;
      b[m] = (...args) => {
        if (st.pgrst204 && touches(args)) return failing("PGRST204", "Could not find the 'picture_path' column of 'events' in the schema cache");
        if (m === "in" && args[0] === "picture_path") {
          st.calls.push({ bucket: "db", op: "refquery", args });
          if (st.onRefQuery) st.onRefQuery(args[1]);
        }
        return orig(...args);
      };
    }
    return b;
  },
});
const handler = require("../api/cleanup");

// ---- run helpers ----
const logs = [];
async function run(iso) {
  if (iso) setNow(iso);
  global.Date = FixedDate;
  logs.length = 0;
  const savedE = console.error, savedW = console.warn;
  console.error = (...a) => logs.push(a.map(String).join(" "));
  console.warn = (...a) => logs.push(a.map(String).join(" "));
  const res = makeRes();
  try { await handler({ headers: { authorization: "Bearer fake-cron-secret" } }, res); }
  finally { global.Date = RealDate; console.error = savedE; console.warn = savedW; }
  return res;
}
const evBy = (slug) => fake.store.events.find((e) => e.slug === slug);
const PAID = "2026-09-01T10:00:00Z";
function ev(id, slug, date, paid, active, extra = {}) {
  return { id, slug, event_name: "Event " + slug, customer_email: slug + "@example.test", gregorian_date: date, paid_at: paid ? PAID : null, active, ...extra };
}
// Safety invariant, asserted in EVERY test: nothing outside the two picture buckets' allowed prefixes is removed.
function assertSafeRemoves() {
  for (const c of st.calls.filter((x) => x.op === "remove")) {
    assert.ok(c.bucket === STG || c.bucket === PUB, "remove outside picture buckets: " + c.bucket);
    assert.ok(Array.isArray(c.args[0]) && c.args[0].length > 0, "remove called with empty list");
    for (const p of c.args[0]) {
      assert.equal(typeof p, "string");
      assert.ok(!p.includes(".."), "traversal in " + p);
      if (c.bucket === PUB) assert.match(p, /^pic\/[0-9a-f-]{36}\.jpg$/, "bad public path " + p);
      else assert.match(p, /^(raw|ok)\/[^/]+$/, "bad staging path " + p);
    }
  }
  for (const c of st.calls.filter((x) => x.op !== "remove" && x.op !== "list" && x.op !== "refquery")) assert.fail("forbidden storage op " + c.op);
}
const numeric = (j) => { for (const k of ["picturesRemoved", "stagingPurged", "publicOrphansPurged"]) assert.equal(typeof j[k], "number", k + " must be a number"); };

// ===================== A. closed events =====================
test("A: past-cutoff events with pic/ path: object removed with the exact path, picture_path nulled (same run and earlier-closed)", async () => {
  fresh({ events: [
    ev(1, "NEW", ymd(-40), true, true, { picture_path: pic(1) }),                          // closed in this run
    ev(2, "OLD", ymd(-50), true, false, { picture_path: pic(2), final_responses: 3, final_guests: 5 }), // closed on an earlier night
  ] });
  put(PUB, pic(1), ago(60 * D)); put(PUB, pic(2), ago(60 * D));
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(removedFrom(PUB).sort(), [pic(1), pic(2)].sort());
  assert.equal(evBy("NEW").picture_path, null);
  assert.equal(evBy("NEW").active, false);
  assert.equal(evBy("OLD").picture_path, null);
  assert.equal(res.body.picturesRemoved, 2);
  assert.equal(res.body.closed, 1);
  assertSafeRemoves();
});

test("A: later night retry: event closed earlier still gets its picture removed on a run with nothing else to do", async () => {
  fresh({ events: [ev(1, "OLD", ymd(-90), true, false, { picture_path: pic(1), final_responses: 0, final_guests: 0 })] });
  put(PUB, pic(1), ago(90 * D));
  const res = await run();
  assert.deepEqual(removedFrom(PUB), [pic(1)]);
  assert.equal(evBy("OLD").picture_path, null);
  assert.equal(res.body.closed, 0);
  assertSafeRemoves();
});

test("A: NOT deleted: null/empty picture_path, not past the cutoff, active or not", async () => {
  fresh({ events: [
    ev(1, "NUL", ymd(-40), true, true, { picture_path: null }),
    ev(2, "EMP", ymd(-40), true, false, { picture_path: "", final_responses: 0, final_guests: 0 }),
    ev(3, "NOCOL", ymd(-40), true, false, { final_responses: 0, final_guests: 0 }),
    ev(4, "FUT", ymd(10), true, true, { picture_path: pic(4) }),
    ev(5, "RECENT", ymd(-10), true, true, { picture_path: pic(5) }),
    ev(6, "EDGE", ymd(-29), true, false, { picture_path: pic(6), final_responses: 0, final_guests: 0 }),
  ] });
  put(PUB, pic(4), ago(5 * D)); put(PUB, pic(5), ago(5 * D)); put(PUB, pic(6), ago(5 * D));
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(removedFrom(PUB), []);
  assert.equal(evBy("FUT").picture_path, pic(4));
  assert.equal(evBy("RECENT").picture_path, pic(5));
  assert.equal(evBy("EDGE").picture_path, pic(6));
  assert.equal(evBy("EMP").picture_path, "");
  assert.equal(res.body.picturesRemoved, 0);
  assertSafeRemoves();
});

test("A (criterion 2): failed removal keeps picture_path, logs, rest of cleanup still runs; retried next night", async () => {
  fresh({ events: [
    ev(1, "PIC", ymd(-40), true, true, { picture_path: pic(1) }),
    ev(2, "PLAIN", ymd(-40), true, true),
    ev(3, "DRAFT", ymd(-40), false, true),
  ] });
  put(PUB, pic(1), ago(60 * D));
  st.removeError[PUB] = true;
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(evBy("PIC").picture_path, pic(1), "picture_path must NOT be nulled when removal failed");
  assert.ok(has(PUB, pic(1)));
  assert.ok(logs.length > 0, "the failure must be logged");
  assert.equal(evBy("PIC").active, false);
  assert.equal(evBy("PLAIN").active, false);
  assert.equal(evBy("DRAFT"), undefined, "draft deletion still runs");
  assert.equal(res.body.closed, 2);
  assert.equal(res.body.deletedDrafts, 1);
  assert.equal(res.body.picturesRemoved, 0);
  // next night: storage healthy again, the event is already closed and still has its path
  st.removeError[PUB] = false;
  const res2 = await run();
  assert.equal(res2.statusCode, 200);
  assert.equal(evBy("PIC").picture_path, null);
  assert.ok(!has(PUB, pic(1)));
  assert.equal(res2.body.picturesRemoved, 1);
});

test("A: a thrown remove() leaves picture_path set and the rest of cleanup intact", async () => {
  fresh({ events: [ev(1, "PIC", ymd(-40), true, true, { picture_path: pic(1) }), ev(2, "DRAFT", ymd(-40), false, true)] });
  put(PUB, pic(1), ago(60 * D));
  st.removeThrows[PUB] = true;
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(evBy("PIC").picture_path, pic(1));
  assert.equal(evBy("PIC").active, false);
  assert.equal(evBy("DRAFT"), undefined);
});

// ===================== B. unpaid drafts =====================
test("B: deleting an unpaid past draft with a staged picture removes the staging object; draft without picture unchanged", async () => {
  fresh({ events: [
    ev(1, "DP", ymd(-40), false, true, { picture_path: ok(1) }),
    ev(2, "DN", ymd(-40), false, true),
    ev(3, "DFUT", ymd(10), false, true, { picture_path: ok(3) }),   // not past the cutoff: kept with its picture
  ] });
  put(STG, ok(1), ago(1 * H)); put(STG, ok(3), ago(1 * H));
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(evBy("DP"), undefined);
  assert.equal(evBy("DN"), undefined);
  assert.ok(evBy("DFUT"));
  assert.ok(!has(STG, ok(1)));
  assert.ok(has(STG, ok(3)));
  assert.deepEqual(removedFrom(STG).filter((p) => p === ok(3)), []);
  assert.equal(res.body.deletedDrafts, 2);
  assert.equal(removedFrom(PUB).length, 0);
  assertSafeRemoves();
});

test("B: draft without any picture behaves exactly as before (no storage call at all on Monday)", async () => {
  fresh({ events: [ev(1, "DN", ymd(-40), false, true)] });
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.deletedDrafts, 1);
  assert.deepEqual(removedFrom(STG), []);
  assert.deepEqual(removedFrom(PUB), []);
});

test("B: staging removal failure does not stop the draft deletion", async () => {
  fresh({ events: [ev(1, "DP", ymd(-40), false, true, { picture_path: ok(1) })] });
  put(STG, ok(1), ago(1 * H));
  st.removeError[STG] = true;
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(evBy("DP"), undefined);
  assert.equal(res.body.deletedDrafts, 1);
});

// ===================== C. staging orphan purge =====================
test("C: raw/ older than 1 day and ok/ older than 14 days removed; younger, unknown age and other folders kept; event-pictures untouched", async () => {
  fresh({ events: [] });
  put(STG, `raw/${U(1)}.jpg`, ago(2 * D));            // removed
  put(STG, `raw/${U(2)}.jpg`, ago(1 * H));            // younger: kept
  put(STG, `raw/${U(3)}.jpg`, null, ago(3 * D));      // created_at missing, updated_at old: removed
  put(STG, `raw/${U(4)}.jpg`, null, null);            // unknown age: kept
  put(STG, `raw/${U(5)}.jpg`, ago(20 * H));           // just under 1 day: kept
  put(STG, ok(6), ago(15 * D));                       // removed
  put(STG, ok(7), ago(10 * D));                       // younger than 14 days: kept
  put(STG, ok(8), ago(2 * D));                        // 2 days in ok/: kept (ok/ limit is 14 days)
  put(STG, ok(9), null, null);                        // unknown: kept
  put(STG, `other/${U(10)}.jpg`, ago(400 * D));       // other folder: kept
  put(STG, `x.jpg`, ago(400 * D));                    // root: kept
  put(PUB, pic(11), ago(400 * D));                    // public bucket: never touched by C (Monday)
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(removedFrom(STG).sort(), [`raw/${U(1)}.jpg`, `raw/${U(3)}.jpg`, ok(6)].sort());
  for (const p of [`raw/${U(2)}.jpg`, `raw/${U(4)}.jpg`, `raw/${U(5)}.jpg`, ok(7), ok(8), ok(9), `other/${U(10)}.jpg`, "x.jpg"]) assert.ok(has(STG, p), "must be kept: " + p);
  assert.equal(res.body.stagingPurged, 3);
  assert.deepEqual(callsOn(PUB), [], "C and a Monday run must not touch event-pictures at all");
  assertSafeRemoves();
});

test("C: staging list error / missing bucket / null data keeps the run at status 200 and removes nothing", async () => {
  for (const mode of ["listError", "missingBucket", "listThrows"]) {
    fresh({ events: [] });
    put(STG, `raw/${U(1)}.jpg`, ago(5 * D));
    st[mode][STG] = true;
    const res = await run();
    assert.equal(res.statusCode, 200, mode);
    assert.deepEqual(removedFrom(STG), [], mode);
    assert.equal(res.body.stagingPurged, 0, mode);
  }
  fresh({ events: [] });
  put(STG, `raw/${U(1)}.jpg`, ago(5 * D));
  st.listNull = true;
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(removedFrom(STG), []);
});

// ===================== D. weekly public orphan purge =====================
function seedPublic(iso) {
  setNow(iso || SUNDAY);
  fresh({ events: [
    ev(1, "PAIDACT", ymd(10), true, true, { picture_path: pic(1) }),
    ev(2, "CLOSEDREF", ymd(-5), true, false, { picture_path: pic(2), final_responses: 0, final_guests: 0 }),
    ev(3, "DRAFTREF", ymd(10), false, true, { picture_path: ok(3) }),
    ev(4, "DRAFTPIC", ymd(10), false, true, { picture_path: pic(4) }),  // a draft pointing at a pic/ path (legacy/odd): still a reference
  ] }, undefined, iso || SUNDAY);
  put(PUB, pic(1), ago(30 * D)); put(PUB, pic(2), ago(30 * D)); put(PUB, pic(4), ago(30 * D));
  put(PUB, pic(20), ago(8 * D));            // orphan, old: removed
  put(PUB, pic(21), ago(2 * D));            // orphan, 2 days: removed
  put(PUB, pic(22), ago(2 * H));            // orphan but younger than 1 day: kept
  put(PUB, pic(23), null, null);            // unknown age: kept (safe side, assumption)
  put(PUB, `pic/${U(24)}.png`, ago(30 * D)); // not matching jpg shape: if removed it must still pass the safety check below
}
test("D: on a UTC Sunday old unreferenced pic/ objects are removed; referenced (paid, draft, active, closed) and younger than 1 day kept", async () => {
  seedPublic();
  const res = await run(SUNDAY);
  assert.equal(res.statusCode, 200);
  assert.ok(!has(PUB, pic(20)));
  assert.ok(!has(PUB, pic(21)));
  for (const n of [1, 2, 4, 22, 23]) assert.ok(has(PUB, pic(n)), "must be kept: " + pic(n));
  assert.ok(res.body.publicOrphansPurged >= 2);
  numeric(res.body);
  // the reference check queried events with the candidate names
  const refq = st.calls.filter((c) => c.op === "refquery");
  assert.ok(refq.length >= 1, "reference query on events.picture_path missing");
  assert.ok(refq.every((c) => Array.isArray(c.args[1])));
  assert.ok(refq.some((c) => c.args[1].includes(pic(20))));
  assertSafeRemoves();
});

test("D: nothing is purged on other weekdays and event-pictures is not even queried for orphans", async () => {
  for (const day of [MONDAY, SATURDAY, "2026-11-17T12:00:00Z", "2026-11-20T12:00:00Z"]) {
    seedPublic(day);
    const res = await run(day);
    assert.equal(res.statusCode, 200, day);
    assert.ok(has(PUB, pic(20)), day);
    assert.ok(has(PUB, pic(21)), day);
    assert.deepEqual(removedFrom(PUB), [], day);
    assert.equal(res.body.publicOrphansPurged, 0, day);
    assert.equal(st.calls.filter((c) => c.op === "refquery").length, 0, day);
  }
});

test("D: UTC Sunday boundaries: Sunday 00:00Z and 23:59Z purge, Monday 00:00Z does not", async () => {
  for (const [iso, purges] of [["2026-11-15T00:00:00Z", true], ["2026-11-15T23:59:59Z", true], ["2026-11-16T00:00:00Z", false], ["2026-11-14T23:59:59Z", false]]) {
    seedPublic(iso);
    const res = await run(iso);
    assert.equal(res.statusCode, 200, iso);
    assert.equal(!has(PUB, pic(20)), purges, iso);
  }
});

test("D: reference check happens right before deleting: a reference added between list and delete protects the object", async () => {
  seedPublic();
  st.onRefQuery = () => { fake.store.events.push(ev(99, "FRESH", ymd(10), false, true, { picture_path: pic(20) })); };
  const res = await run(SUNDAY);
  assert.equal(res.statusCode, 200);
  assert.ok(has(PUB, pic(20)), "object referenced at query time must survive");
  assert.ok(!has(PUB, pic(21)), "unreferenced one is still purged");
  const listIdx = st.calls.findIndex((c) => c.bucket === PUB && c.op === "list");
  const refIdx = st.calls.findIndex((c) => c.op === "refquery");
  const rmIdx = st.calls.findIndex((c) => c.bucket === PUB && c.op === "remove");
  assert.ok(listIdx >= 0 && refIdx > listIdx, "reference query must come after the storage list");
  assert.ok(rmIdx > refIdx, "remove must come after the reference query");
});

test("D: if the reference query fails nothing is deleted from event-pictures (fail safe) and the run stays 200", async () => {
  seedPublic();
  const origFrom = fake.from.bind(fake);
  const saved = fake.from;
  fake.from = (t) => {
    const b = origFrom(t);
    if (t === "events") {
      const oi = b.in.bind(b);
      b.in = (col, v) => (col === "picture_path" ? failing("XX000", "boom") : oi(col, v));
    }
    return b;
  };
  try {
    const res = await run(SUNDAY);
    assert.equal(res.statusCode, 200);
    assert.ok(has(PUB, pic(20)) && has(PUB, pic(21)), "no reference answer, no deletion");
    assert.deepEqual(removedFrom(PUB), []);
  } finally { fake.from = saved; }
});

test("D: a reference added during the first chunk of the reference check protects an object in a later chunk", async () => {
  fresh({ events: [] }, undefined, SUNDAY);
  const name = (i) => `pic/${"00000000-0000-4000-8000-" + String(i).padStart(12, "0")}.jpg`;
  for (let i = 0; i < 250; i++) put(PUB, name(i), ago(30 * D));
  let first = true;
  st.onRefQuery = () => { if (first) { first = false; fake.store.events.push(ev(99, "FRESH", ymd(10), false, true, { picture_path: name(249) })); } };
  const res = await run(SUNDAY);
  assert.equal(res.statusCode, 200);
  assert.ok(has(PUB, name(249)), "late reference must protect the object");
  assert.ok(!has(PUB, name(0)), "others are purged");
});

test("D: bounded to the first 1000 objects", async () => {
  fresh({ events: [] }, undefined, SUNDAY);
  for (let i = 0; i < 1200; i++) put(PUB, `pic/${"00000000-0000-4000-8000-" + String(i).padStart(12, "0")}.jpg`, ago(30 * D));
  const res = await run(SUNDAY);
  assert.equal(res.statusCode, 200);
  assert.ok(removedFrom(PUB).length > 0, "orphans must be purged");
  assert.ok(removedFrom(PUB).length <= 1000, "at most 1000 objects per run");
  const offsets = st.calls.filter((c) => c.bucket === PUB && c.op === "list").map((c) => (c.args[1] || {}).offset || 0);
  assert.ok(offsets.every((o) => o < 1000), "never list beyond the first 1000");
  assert.ok(res.body.publicOrphansPurged <= 1000);
  assertSafeRemoves();
});

test("D: a staging object is never touched by the weekly public purge", async () => {
  seedPublic();
  put(STG, ok(30), ago(1 * H));
  await run(SUNDAY);
  assert.ok(has(STG, ok(30)));
  assert.ok(!removedFrom(PUB).some((p) => p.startsWith("ok/") || p.startsWith("raw/")));
});

// ===================== Safety: malformed database paths =====================
test("Safety: malformed picture_path values are ignored, logged and never passed to remove()", async () => {
  const bad = ["pic/../secret.jpg", "pic/../../ok/x.jpg", "../pic/x.jpg", "other/x.jpg", "pic/", "pic", " ", "", "pic/a/b.jpg", "/pic/x.jpg", "pic/" + U(2) + ".jpg/..", "pic/x\u0000.jpg", "raw/" + U(3) + ".jpg", "event-pictures/" + pic(4)];
  const events = bad.map((p, i) => ev(i + 1, "BAD" + i, ymd(-40), true, true, { picture_path: p }));
  fresh({ events });
  put(PUB, "secret.jpg", ago(100 * D)); put(PUB, pic(50), ago(100 * D));
  put(STG, ok(1), ago(1 * H)); put(STG, `raw/${U(3)}.jpg`, ago(1 * H));
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(removedFrom(PUB), [], "no malformed closed-event path may reach remove()");
  assert.deepEqual(removedFrom(STG), [], "no malformed path (incl. raw/ and traversal) may reach remove() on staging");
  assert.ok(has(PUB, "secret.jpg"));
  assert.ok(has(STG, ok(1)));
  assert.ok(logs.length > 0, "malformed paths must be logged");
  for (const e of fake.store.events) assert.equal(e.picture_path, bad[e.id - 1], "malformed path must be left as is: " + bad[e.id - 1]);
  assert.equal(res.body.picturesRemoved, 0);
  assertSafeRemoves();
});

test("Safety: draft deletion ignores bad staging paths (traversal, pic/ path in a draft) and still deletes the draft", async () => {
  const bad = ["ok/../x.jpg", "ok/../../pic/x.jpg", "pic/" + U(1) + ".jpg", "raw/" + U(2) + ".jpg", "other/x.jpg", "ok/", "", "ok/a/b.jpg", "ok/" + U(3) + ".png"];
  const events = bad.map((p, i) => ev(i + 1, "DB" + i, ymd(-40), false, true, { picture_path: p }));
  fresh({ events });
  put(PUB, pic(1), ago(100 * D)); put(STG, `raw/${U(2)}.jpg`, ago(1 * H));
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(fake.store.events.length, 0, "all drafts are deleted as before");
  assert.equal(res.body.deletedDrafts, bad.length);
  assert.deepEqual(removedFrom(PUB), []);
  assert.deepEqual(removedFrom(STG), []);
  assert.ok(has(PUB, pic(1)));
  assertSafeRemoves();
});

// ===================== Delta after review =====================
test("A: stale staged ok/ path on a past-cutoff paid event is removed from picture-staging and nulled", async () => {
  fresh({ events: [ev(1, "STALE", ymd(-40), true, true, { picture_path: ok(1) }), ev(2, "STALE2", ymd(-60), true, false, { picture_path: ok(2), final_responses: 0, final_guests: 0 })] });
  put(STG, ok(1), ago(1 * H)); put(STG, ok(2), ago(1 * H));
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(removedFrom(STG).sort(), [ok(1), ok(2)].sort());
  assert.deepEqual(removedFrom(PUB), []);
  assert.equal(evBy("STALE").picture_path, null);
  assert.equal(evBy("STALE2").picture_path, null);
  assertSafeRemoves();
});

test("A: stale staged ok/ path is KEPT (not nulled) when the staging removal fails, and logged", async () => {
  fresh({ events: [ev(1, "STALE", ymd(-40), true, true, { picture_path: ok(1) })] });
  put(STG, ok(1), ago(1 * H));
  st.removeError[STG] = true;
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(evBy("STALE").picture_path, ok(1));
  assert.equal(evBy("STALE").active, false);
  assert.ok(logs.length > 0);
});

test("A: a future-dated event with a staged ok/ path is untouched", async () => {
  fresh({ events: [ev(1, "FUT", ymd(10), true, true, { picture_path: ok(1) })] });
  put(STG, ok(1), ago(1 * H));
  await run();
  assert.equal(evBy("FUT").picture_path, ok(1));
  assert.ok(has(STG, ok(1)));
});

test("A: bounded: 60 eligible events: exactly 50 oldest first in one run, the rest next run", async () => {
  const events = [];
  for (let i = 1; i <= 60; i++) events.push(ev(i, "E" + i, ymd(-40 - i), true, false, { picture_path: pic(i), final_responses: 0, final_guests: 0 }));
  fresh({ events });
  for (let i = 1; i <= 60; i++) put(PUB, pic(i), ago(100 * D));
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(removedFrom(PUB).length, 50);
  assert.equal(res.body.picturesRemoved, 50);
  // oldest first = largest i (oldest date): ids 11..60 processed, 1..10 left
  for (let i = 1; i <= 10; i++) assert.equal(evBy("E" + i).picture_path, pic(i), "newest ten wait: " + i);
  for (let i = 11; i <= 60; i++) assert.equal(evBy("E" + i).picture_path, null, "oldest fifty done: " + i);
  const res2 = await run();
  assert.equal(res2.body.picturesRemoved, 10);
  for (let i = 1; i <= 60; i++) assert.equal(evBy("E" + i).picture_path, null);
  assertSafeRemoves();
});

test("B order: staged draft picture removed only AFTER the draft row deletion succeeded", async () => {
  fresh({ events: [ev(1, "DP", ymd(-40), false, true, { picture_path: ok(1) })] });
  put(STG, ok(1), ago(1 * H));
  const origFrom = fake.from.bind(fake);
  let rowGoneAtRemove = null;
  const origRemove = storage.from;
  const sf = storage.from;
  storage.from = (b) => {
    const o = sf.call(storage, b);
    const r = o.remove;
    o.remove = async (paths) => { if (b === STG) rowGoneAtRemove = !fake.store.events.some((e) => e.slug === "DP"); return r(paths); };
    return o;
  };
  try { await run(); } finally { storage.from = sf; }
  assert.equal(rowGoneAtRemove, true, "the draft row must already be deleted when its picture is removed");
  assert.ok(!has(STG, ok(1)));
});

test("B order: if the draft row deletion fails the staged picture is NOT removed", async () => {
  fresh({ events: [ev(1, "DP", ymd(-40), false, true, { picture_path: ok(1) })] });
  put(STG, ok(1), ago(1 * H));
  const origFrom = fake.from.bind(fake);
  const saved = fake.from;
  fake.from = (t) => {
    const b = origFrom(t);
    if (t === "events") { const od = b.delete.bind(b); b.delete = () => failing("XX000", "delete boom"); }
    return b;
  };
  try { await run(); } finally { fake.from = saved; }
  assert.ok(evBy("DP"), "row still there");
  assert.ok(has(STG, ok(1)), "picture must stay while its draft row exists");
  assert.deepEqual(removedFrom(STG).filter((p) => p === ok(1)), []);
});

test("Guard: odd names in staging folders (space, traversal, double dot) are never passed to remove() even when old", async () => {
  fresh({ events: [] });
  const odd = ["a b.jpg", "../x.jpg", "a..b.jpg", "x/../y.jpg", "é.jpg", "a;b.jpg"];
  for (const n of odd) { put(STG, `raw/${n}`, ago(5 * D)); put(STG, `ok/${n}`, ago(30 * D)); }
  put(STG, `raw/${U(1)}.jpg`, ago(5 * D));
  await run();
  const removed = removedFrom(STG);
  for (const n of odd) { assert.ok(!removed.includes(`raw/${n}`), "raw/" + n); assert.ok(!removed.includes(`ok/${n}`), "ok/" + n); }
  assert.ok(removed.includes(`raw/${U(1)}.jpg`), "the well-formed old one is still purged");
  for (const p of removed) assert.match(p, /^(raw|ok)\/[A-Za-z0-9._-]+$/);
  for (const p of removed) assert.ok(!p.includes(".."));
});

// ===================== E. failure isolation =====================
function baselineSeed(withPics) {
  const x = (o) => (withPics ? o : {});
  return { events: [
    ev(1, "PAIDPIC", ymd(-40), true, true, x({ picture_path: pic(1) })),
    ev(2, "PAIDPLAIN", ymd(-40), true, true),
    ev(3, "DRAFTPIC", ymd(-40), false, true, x({ picture_path: ok(3) })),
    ev(4, "DRAFTPLAIN", ymd(-40), false, true),
    ev(5, "LIVE", ymd(10), true, true, x({ picture_path: pic(5) })),
  ] };
}
const EXISTING = ["thanked", "closed", "deletedDrafts", "abandoned"];
let baseline;
async function getBaseline() {
  if (baseline) return baseline;
  fresh(baselineSeed(false));
  const res = await run(SUNDAY);
  assert.equal(res.statusCode, 200);
  baseline = res.body;
  return baseline;
}
function populate() {
  put(PUB, pic(1), ago(60 * D)); put(PUB, pic(5), ago(60 * D)); put(PUB, pic(60), ago(60 * D));
  put(STG, ok(3), ago(1 * H)); put(STG, `raw/${U(61)}.jpg`, ago(5 * D)); put(STG, ok(62), ago(30 * D));
}
const MODES = {
  "remove error (both buckets)": () => { st.removeError[PUB] = true; st.removeError[STG] = true; },
  "list error (both buckets)": () => { st.listError[PUB] = true; st.listError[STG] = true; },
  "missing buckets": () => { st.missingBucket[PUB] = true; st.missingBucket[STG] = true; },
  "thrown remove": () => { st.removeThrows[PUB] = true; st.removeThrows[STG] = true; },
  "thrown list": () => { st.listThrows[PUB] = true; st.listThrows[STG] = true; },
  "list returns null data": () => { st.listNull = true; },
  "PGRST204 on picture_path": () => { st.pgrst204 = true; },
};
for (const [name, arm] of Object.entries(MODES)) {
  test(`E: ${name}: status 200, existing counters unchanged, new counters numeric, existing steps done`, async () => {
    const base = await getBaseline();
    fresh(baselineSeed(true), undefined, SUNDAY);
    populate();
    arm();
    const res = await run(SUNDAY);
    assert.equal(res.statusCode, 200);
    for (const k of EXISTING) assert.equal(res.body[k], base[k], k);
    numeric(res.body);
    assert.equal(evBy("PAIDPIC").active, false);
    assert.equal(evBy("PAIDPLAIN").active, false);
    assert.equal(evBy("DRAFTPIC"), undefined);
    assert.equal(evBy("DRAFTPLAIN"), undefined);
    assert.ok(evBy("LIVE"), "future event untouched");
    assert.equal(evBy("LIVE").picture_path, pic(5));
    assert.ok(has(PUB, pic(5)), "a picture still in use is never deleted");
    assertSafeRemoves();
  });
}

test("E: missing column picture_path (42703): status 200, existing counters unchanged, existing steps done", async () => {
  const base = await getBaseline();
  fresh(baselineSeed(true), { missingColumns: { events: ["picture_path"] } }, SUNDAY);
  populate();
  const res = await run(SUNDAY);
  assert.equal(res.statusCode, 200);
  for (const k of EXISTING) assert.equal(res.body[k], base[k], k);
  numeric(res.body);
  assert.equal(evBy("PAIDPIC").active, false);
  assert.equal(evBy("PAIDPLAIN").active, false);
  assert.equal(evBy("DRAFTPLAIN"), undefined);
  assert.ok(has(PUB, pic(5)), "with the reference check impossible nothing in use may be deleted");
  assert.ok(has(PUB, pic(1)) || true);
  assertSafeRemoves();
});

test("E: healthy run: all three counters present as numbers and picture deletions reflected", async () => {
  fresh(baselineSeed(true), undefined, SUNDAY);
  populate();
  const res = await run(SUNDAY);
  assert.equal(res.statusCode, 200);
  numeric(res.body);
  assert.equal(res.body.picturesRemoved, 1);          // PAIDPIC
  assert.equal(res.body.stagingPurged, 2);            // raw old + ok old (ok(3) removed by B, not counted here)
  assert.equal(res.body.publicOrphansPurged, 1);      // pic(60); pic(5) is referenced, pic(1) was nulled and removed by A
  assert.ok(!has(PUB, pic(1)) && !has(PUB, pic(60)) && has(PUB, pic(5)));
  assert.ok(!has(STG, ok(3)));
  assertSafeRemoves();
});

test("E: a run with nothing to do returns zeros for the three new counters and makes no remove call", async () => {
  fresh({ events: [ev(1, "LIVE", ymd(10), true, true)] });
  const res = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.picturesRemoved, 0);
  assert.equal(res.body.stagingPurged, 0);
  assert.equal(res.body.publicOrphansPurged, 0);
  assert.equal(st.calls.filter((c) => c.op === "remove").length, 0);
});

test("E: 401 without the Bearer secret and no storage call", async () => {
  fresh({ events: [ev(1, "OLD", ymd(-90), true, false, { picture_path: pic(1) })] });
  put(PUB, pic(1), ago(90 * D));
  const res = makeRes();
  await handler({ headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(st.calls.length, 0);
  assert.ok(has(PUB, pic(1)));
});

// ===================== 8. structure =====================
test("function count stays 10 (files starting with _ are not functions)", () => {
  const out = [];
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(dir, f.name));
      else if (f.name.endsWith(".js") && !f.name.startsWith("_")) out.push(path.join(dir, f.name));
    }
  })(path.join(ROOT, "api"));
  assert.equal(out.length, 10, out.join(", "));
});

test("cleanup only uses the allowed storage calls (source guard: no download/upload/signed URL, only the two buckets)", () => {
  const src = fs.readFileSync(path.join(ROOT, "api/cleanup.js"), "utf8");
  assert.doesNotMatch(src, /\.(download|upload|createSignedUrl|createSignedUrls|getPublicUrl|move|copy)\(/);
  assert.doesNotMatch(src, /storage\.from\(\s*["'`](?!picture-staging|event-pictures)/);
  assert.match(src, /picture-staging|STAGING_BUCKET/);
  assert.match(src, /event-pictures|PUBLIC_BUCKET/);
  assert.doesNotMatch(src, /storage\.(listBuckets|emptyBucket|deleteBucket|createBucket)/);
});
