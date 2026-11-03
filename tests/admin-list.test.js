"use strict";
// Proves GET /api/admin-events lists every paid event (past, today, future; active, paused, closed),
// no unpaid draft, newest payment first, with the count and snapshot fields the admin page needs.
// (the list itself is unchanged; the abandoned-count read failure now returns null). Runs the real handler
// against an in-memory fake Supabase (tests/_fake-supabase.js). No network, no real database.
const fetchCalls = [];
global.fetch = async (...args) => { fetchCalls.push(args); throw new Error("network is blocked in tests"); };
delete process.env.BREVO_API_KEY;            // _sweep.js sendEmail returns early without it
process.env.ADMIN_PASSWORD = "fake-admin-pass";
process.env.CRON_SECRET = "fake-cron-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");

const DAY = 24 * 60 * 60 * 1000;

function ev(id, slug, gregorian_date, active, paid_at, final_responses = null, final_guests = null) {
  return {
    id, slug, event_name: "Event " + slug, event_type: "bar_mitzvah", gregorian_date, active, paid_at,
    final_responses, final_guests,
    customer_name: "Fake Customer", customer_email: slug + "@example.test", dashboard_password: "fake-pw",
    event_time: "19:00", location: "Fake Hall",
  };
}

const PAID_ORDER = ["past-active", "past-paused", "past-closed", "today-active", "future-active", "future-paused"];

function seed() {
  return {
    events: [
      ev(1, "past-active",   "2026-10-08", true,  "2026-09-20T10:00:00Z"),
      ev(2, "past-paused",   "2026-10-20", false, "2026-09-18T10:00:00Z"),
      ev(3, "past-closed",   "2026-09-16", false, "2026-09-10T10:00:00Z", 40, 95),
      ev(4, "today-active",  "2026-11-02", true,  "2026-09-05T10:00:00Z"),
      ev(5, "future-active", "2026-12-01", true,  "2026-09-04T10:00:00Z"),
      ev(6, "future-paused", "2026-12-15", false, "2026-09-03T10:00:00Z"),
      ev(7, "draft-past",    "2026-08-01", true,  null),
      ev(8, "draft-future",  "2027-01-01", true,  null),
    ],
    rsvps: [
      { id: 1, event_id: 1, name: "A", attending: true, guests: 2 },
      { id: 2, event_id: 1, name: "B", attending: true, guests: 1 },
      { id: 3, event_id: 1, name: "C", attending: false, guests: 0 },
      { id: 4, event_id: 5, name: "D", attending: true, guests: 4 },
    ],
    checkout_abandonments: [
      { id: 1, abandoned_at: new Date(Date.now() - 1 * DAY).toISOString() },
      { id: 2, abandoned_at: new Date(Date.now() - 40 * DAY).toISOString() },
    ],
  };
}

const fake = createFakeSupabase(seed());
install(fake);
const handler = require("../api/admin-events");

async function getList() {
  const res = makeRes();
  await handler({ method: "GET", headers: { authorization: "Bearer fake-admin-pass" }, query: {} }, res);
  return res;
}

test("GET /api/admin-events returns every paid event: past, today, future, active, paused, closed", async () => {
  const res = await getList();
  assert.equal(res.statusCode, 200);
  const slugs = res.body.events.map((e) => e.slug).sort();
  assert.deepEqual(slugs, PAID_ORDER.slice().sort());
});

test("GET /api/admin-events returns no unpaid drafts", async () => {
  const res = await getList();
  const slugs = res.body.events.map((e) => e.slug);
  assert.ok(!slugs.includes("draft-past"));
  assert.ok(!slugs.includes("draft-future"));
});

test("GET /api/admin-events orders events by paid_at descending", async () => {
  const res = await getList();
  assert.deepEqual(res.body.events.map((e) => e.slug), PAID_ORDER);
});

test("GET /api/admin-events keeps rsvp_count, final_responses, final_guests, gregorian_date and active", async () => {
  const res = await getList();
  const by = (slug) => res.body.events.find((e) => e.slug === slug);
  assert.equal(by("past-active").rsvp_count, 3);
  assert.equal(by("future-active").rsvp_count, 1);
  assert.equal(by("past-closed").rsvp_count, 0);
  assert.equal(by("past-closed").final_responses, 40);
  assert.equal(by("past-closed").final_guests, 95);
  assert.equal(by("past-paused").active, false);
  assert.equal(by("future-paused").active, false);
  assert.equal(by("past-active").active, true);
  for (const e of res.body.events) {
    assert.match(e.gregorian_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(e.rsvps, undefined, "the embedded rsvps(count) is flattened into rsvp_count");
  }
});

test("the events list query has no filter on active or gregorian_date", async () => {
  const before = fake.calls.length;
  await getList();
  const call = fake.calls.slice(before).find((c) => c.table === "events" && c.cols && c.cols.includes("rsvps(count)"));
  assert.ok(call, "the events list query was logged");
  assert.deepEqual(call.filters, [{ type: "not_is", col: "paid_at", value: null }]);
  assert.deepEqual(call.order, { col: "paid_at", ascending: false });
});

test("the fake really applies filters: adding eq(active,true) drops rows", async () => {
  const all = await fake.from("events").select("slug").not("paid_at", "is", null);
  const activeOnly = await fake.from("events").select("slug").not("paid_at", "is", null).eq("active", true);
  assert.equal(all.data.length, 6);
  assert.ok(activeOnly.data.length < all.data.length);
  assert.equal(activeOnly.data.length, 3);
});

test("abandonedLast30Days counts only abandonments of the last 30 days", async () => {
  const res = await getList();
  assert.equal(res.body.abandonedLast30Days, 1);
});

test("abandoned count read failure returns null and still lists events", async () => {
  const realFrom = fake.from;
  const realError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args); };
  fake.from = (table) => {
    if (table !== "checkout_abandonments") return realFrom.call(fake, table);
    const failed = { data: null, count: null, error: { code: "PGRST205", message: "Could not find the table" } };
    const api = {
      select() { return api; },
      gte() { return api; },
      then: (resolve, reject) => Promise.resolve(failed).then(resolve, reject),
    };
    return api;
  };
  let res;
  try {
    res = await getList();
  } finally {
    fake.from = realFrom;
    console.error = realError;
  }
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.abandonedLast30Days, null);
  assert.deepEqual(res.body.events.map((e) => e.slug), PAID_ORDER);
  assert.ok(errors.some((a) => a[0] === "checkout_abandonments count error:"), "the failure is logged");
});

test("GET /api/admin-events without a valid Bearer returns 401", async () => {
  const before = fake.calls.length;
  const noHeader = makeRes();
  await handler({ method: "GET", headers: {}, query: {} }, noHeader);
  const wrong = makeRes();
  await handler({ method: "GET", headers: { authorization: "Bearer wrong-value" }, query: {} }, wrong);
  assert.equal(noHeader.statusCode, 401);
  assert.equal(wrong.statusCode, 401);
  assert.equal(fake.calls.slice(before).filter((c) => c.table === "events").length, 0);
});

test("admin-list tests made no network call", () => {
  assert.equal(fetchCalls.length, 0);
});
