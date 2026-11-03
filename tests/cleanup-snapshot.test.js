"use strict";
// Regression test for the daily cleanup job (api/cleanup.js): the final_responses / final_guests snapshot is
// written once. An event closed before and reactivated by the owner ("▶️ הפעל" in /admin) is closed again
// with its saved headcount kept (a recount would give 0/0, its replies were deleted at the first close).
// Runs the real handler against the in-memory fake Supabase (tests/_fake-supabase.js). No network.
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

function ev(id, slug, gregorian_date, paid_at, active, extra = {}) {
  return { id, slug, event_name: "Event " + slug, customer_email: slug + "@example.test", gregorian_date, paid_at, active, ...extra };
}
function reply(id, event_id, attending, guests) {
  return { id, event_id, name: "Guest " + id, attending, guests };
}

const fake = createFakeSupabase({
  events: [
    ev(1, "R1", ymd(-60), PAID, true, { final_responses: 40, final_guests: 95 }),
    ev(2, "R2", ymd(-60), PAID, true, { final_responses: 40, final_guests: 95 }),
    ev(3, "N1", ymd(-40), PAID, true),
    ev(4, "Z1", ymd(-45), PAID, true, { final_responses: 0, final_guests: 0 }),
    ev(5, "F1", ymd(10),  PAID, true, { final_responses: 40, final_guests: 95 }),
    ev(6, "P2", ymd(-40), PAID, false),
    ev(7, "D1", ymd(-40), null, true),
    ev(8, "D2", ymd(30),  null, true),
  ],
  rsvps: [
    reply(1, 2, true, 1), reply(2, 2, true, 2),
    reply(3, 3, true, 2), reply(4, 3, true, 3), reply(5, 3, false, 1),
    reply(6, 5, true, 1),
    reply(7, 6, true, 1), reply(8, 6, true, 1),
    reply(9, 7, true, 1),
  ],
});
install(fake);
const handler = require("../api/cleanup");

const cronReq = () => ({ headers: { authorization: "Bearer fake-cron-secret" } });
const eventBy = (slug) => fake.store.events.find((e) => e.slug === slug);
const repliesOf = (id) => fake.store.rsvps.filter((r) => r.event_id === id);

// One run before any test, so every test is valid on its own (for example with --test-name-pattern).
let firstRun;
const warnings = [];
before(async () => {
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    firstRun = makeRes();
    await handler(cronReq(), firstRun);
  } finally {
    console.warn = realWarn;
  }
});

test("reactivated event keeps its saved 40/95", () => {
  const r1 = eventBy("R1");
  assert.equal(r1.active, false);
  assert.equal(r1.final_responses, 40);
  assert.equal(r1.final_guests, 95);
});

test("replies after reactivation are deleted and not counted, with one warn line", () => {
  const r2 = eventBy("R2");
  assert.equal(r2.active, false);
  assert.equal(r2.final_responses, 40);
  assert.equal(r2.final_guests, 95);
  assert.equal(repliesOf(2).length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(String(r2.id)), "the warn line holds the event id");
  assert.ok(!/Guest|example\.test/.test(warnings[0]), "the warn line holds no personal data");
});

test("event without snapshot gets a snapshot", () => {
  const n1 = eventBy("N1");
  assert.equal(n1.active, false);
  assert.equal(n1.final_responses, 3);
  assert.equal(n1.final_guests, 5);
  assert.equal(repliesOf(3).length, 0);
});

test("0/0 snapshot stays 0/0", () => {
  const z1 = eventBy("Z1");
  assert.equal(z1.active, false);
  assert.equal(z1.final_responses, 0);
  assert.equal(z1.final_guests, 0);
});

test("future-dated reactivated event is untouched", () => {
  const f1 = eventBy("F1");
  assert.equal(f1.active, true);
  assert.equal(f1.final_responses, 40);
  assert.equal(f1.final_guests, 95);
  assert.equal(repliesOf(5).length, 1);
});

test("paused past event untouched", () => {
  const p2 = eventBy("P2");
  assert.equal(p2.active, false);
  assert.ok(p2.final_responses == null);
  assert.equal(repliesOf(6).length, 2);
});

test("drafts handled as before", () => {
  const slugs = fake.store.events.map((e) => e.slug);
  assert.ok(!slugs.includes("D1"));
  assert.equal(repliesOf(7).length, 0);
  assert.ok(slugs.includes("D2"));
});

test("cleanup body counts the re-closed events too", () => {
  assert.equal(firstRun.statusCode, 200);
  assert.equal(firstRun.body.closed, 4);
  assert.equal(firstRun.body.deletedDrafts, 1);
});

test("only the event without a snapshot is ever given final_* numbers (structural)", () => {
  const writes = fake.calls.filter((c) => c.table === "events" && c.op === "update" && c.payload && "final_responses" in c.payload);
  assert.equal(writes.length, 1);
  const byId = writes[0].filters.find((f) => f.type === "eq" && f.col === "id");
  assert.ok(byId, "the snapshot update has an eq id filter");
  assert.equal(byId.value, eventBy("N1").id);
  // the re-close updates carry only active=false
  const reCloses = fake.calls.filter((c) => c.table === "events" && c.op === "update" && c.payload && !("final_responses" in c.payload));
  assert.equal(reCloses.length, 3);
  for (const c of reCloses) assert.deepEqual(c.payload, { active: false });
});

test("a second cleanup run is idempotent", async () => {
  const res = makeRes();
  await handler(cronReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.closed, 0);
  assert.equal(eventBy("R1").final_responses, 40);
  assert.equal(eventBy("R1").final_guests, 95);
  assert.equal(eventBy("N1").final_responses, 3);
  assert.equal(eventBy("N1").final_guests, 5);
  assert.equal(eventBy("Z1").final_responses, 0);
});

test("cleanup snapshot tests made no network call", () => {
  assert.equal(fetchCalls.length, 0);
});
