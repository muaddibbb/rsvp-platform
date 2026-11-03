"use strict";
// Regression test for the daily cleanup job (api/cleanup.js, unchanged by this run): it never deletes a
// paid event row, it closes an active paid event more than 30 days past (snapshot written, guest replies
// deleted), and it deletes unpaid past drafts. Runs the real handler against an in-memory fake Supabase
// (tests/_fake-supabase.js). No network, no real database.
const fetchCalls = [];
global.fetch = async (...args) => { fetchCalls.push(args); throw new Error("network is blocked in tests"); };
delete process.env.BREVO_API_KEY;            // _sweep.js sendEmail returns early without it
process.env.ADMIN_PASSWORD = "fake-admin-pass";
process.env.CRON_SECRET = "fake-cron-secret";

const test = require("node:test");
const { before } = test;
const assert = require("node:assert/strict");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");

const ymd = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const PAID = "2026-09-01T10:00:00Z";

function ev(id, slug, gregorian_date, paid_at, active) {
  return { id, slug, event_name: "Event " + slug, customer_email: slug + "@example.test", gregorian_date, paid_at, active };
}
function reply(id, event_id, attending, guests) {
  return { id, event_id, name: "Guest " + id, attending, guests };
}

const fake = createFakeSupabase({
  events: [
    ev(1, "P1", ymd(-40), PAID, true),
    ev(2, "P2", ymd(-40), PAID, false),
    ev(3, "P3", ymd(-10), PAID, true),
    ev(4, "P4", ymd(30),  PAID, true),
    ev(5, "D1", ymd(-40), null, true),
    ev(6, "D2", ymd(30),  null, true),
  ],
  rsvps: [
    reply(1, 1, true, 2), reply(2, 1, true, 3), reply(3, 1, false, 1),
    reply(4, 2, true, 1), reply(5, 2, true, 1),
    reply(6, 3, true, 1), reply(7, 3, true, 1),
    reply(8, 4, true, 1),
    reply(9, 5, true, 1),
  ],
});
install(fake);
const handler = require("../api/cleanup");

const cronReq = () => ({ headers: { authorization: "Bearer fake-cron-secret" } });
const slugsLeft = () => fake.store.events.map((e) => e.slug);
const eventBy = (slug) => fake.store.events.find((e) => e.slug === slug);
const repliesOf = (id) => fake.store.rsvps.filter((r) => r.event_id === id);

// The first cleanup run happens once, before any test, so every test below is valid on its own
// (for example with --test-name-pattern) and never passes only because the seed was left untouched.
let firstRun;
before(async () => {
  firstRun = makeRes();
  await handler(cronReq(), firstRun);
});

test("cleanup returns closed 1 and deletedDrafts 1", () => {
  assert.equal(firstRun.statusCode, 200);
  assert.deepEqual(firstRun.body, { thanked: 0, closed: 1, deletedDrafts: 1, abandoned: 0 });
});

test("cleanup keeps every paid event row", () => {
  for (const slug of ["P1", "P2", "P3", "P4"]) assert.ok(slugsLeft().includes(slug), slug + " still exists");
});

test("cleanup closes an active paid event more than 30 days past: snapshot written, replies deleted", () => {
  const p1 = eventBy("P1");
  assert.equal(p1.active, false);
  assert.equal(p1.final_responses, 3);
  assert.equal(p1.final_guests, 5);
  assert.equal(repliesOf(1).length, 0);
});

test("cleanup leaves recent and future paid events untouched", () => {
  for (const [slug, id, n] of [["P3", 3, 2], ["P4", 4, 1]]) {
    const e = eventBy(slug);
    assert.equal(e.active, true);
    assert.equal(repliesOf(id).length, n);
    assert.ok(e.final_responses == null);
  }
});

test("cleanup deletes an unpaid past draft with its replies and keeps a future draft", () => {
  assert.ok(!slugsLeft().includes("D1"));
  assert.equal(repliesOf(5).length, 0);
  assert.ok(slugsLeft().includes("D2"));
});

test("cleanup never deletes an events row that could match a paid event (structural)", () => {
  const deletes = fake.calls.filter((c) => c.table === "events" && c.op === "delete");
  assert.ok(deletes.length >= 1);
  for (const d of deletes) {
    const inId = d.filters.find((f) => f.type === "in" && f.col === "id");
    assert.ok(inId, "every events delete filters by id in (...)");
    assert.deepEqual(inId.value, [5]);
  }
});

test("documents J-10: a paused paid event past 30 days keeps its replies", () => {
  // The close step selects only active=true rows, so a paused paid event past 30 days is never closed
  // and its guest replies stay. This assertion changes when J-10 is fixed (same idea as the J-29
  // documenting test in tests/sync-points.test.js).
  const p2 = eventBy("P2");
  assert.equal(repliesOf(2).length, 2);
  assert.equal(p2.active, false);
  assert.ok(p2.final_responses == null);
});

test("a second cleanup run is idempotent", async () => {
  const res = makeRes();
  await handler(cronReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.closed, 0);
  assert.equal(res.body.deletedDrafts, 0);
  assert.equal(eventBy("P1").final_responses, 3);
  assert.equal(eventBy("P1").final_guests, 5);
  assert.ok(firstRun);
});

test("cleanup without the Bearer secret returns 401", async () => {
  const callsBefore = fake.calls.length;
  const none = makeRes();
  await handler({ headers: {} }, none);
  const wrong = makeRes();
  await handler({ headers: { authorization: "Bearer wrong-value" } }, wrong);
  assert.equal(none.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(fake.calls.length, callsBefore, "no query ran for an unauthorized call");
});

test("cleanup tests made no network call", () => {
  assert.equal(fetchCalls.length, 0);
});
