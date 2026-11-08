"use strict";
// J-04: caller text is escaped in every e-mail the public endpoints send, and the public endpoints refuse
// after N calls per window (per IP and per e-mail address), fail open when the counter is unavailable,
// give no-Origin callers a quarter of the limits and refuse a foreign Origin.
// Offline: Brevo and PayPal are stubbed (tests/_paypal-stub.js), Supabase is the in-memory fake.
process.env.PAYPAL_CLIENT_ID = "fake-client-id";
process.env.PAYPAL_SECRET = "fake-paypal-secret-value";
process.env.PAYPAL_SANDBOX = "true";
process.env.BREVO_API_KEY = "fake-brevo-key-value";
process.env.CRON_SECRET = "fake-cron-secret";
delete process.env.ORDER_SIGNING_KEY;

const test = require("node:test");
require("./_quiet")(test);   // M-1: keep handler logging off the runner's result pipe
const assert = require("node:assert/strict");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");
const { installFetchStub, approvedOrder, completedCapture, makeCustomId } = require("./_paypal-stub");

const stub = installFetchStub();
let fake = createFakeSupabase();
// The api files grab their client once at require time: hand them a proxy that follows `fake`.
install({
  from: (t) => fake.from(t),
  rpc: (n, a) => fake.rpc(n, a),
});
const createEvent = require("../api/create-event");
const capture = require("../api/paypal-capture");
const createOrder = require("../api/paypal-create-order");
const cleanup = require("../api/cleanup");
const recovery = require("../api/_recovery");
const mail = require("../api/_mail");

const FUTURE = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
const SITE = { origin: "https://rsvp.kupernet.com", host: "rsvp.kupernet.com" };
const H = (ip = "203.0.113.7", extra = SITE) => ({ ...extra, "x-forwarded-for": ip });
const NO_ORIGIN = (ip = "203.0.113.7") => ({ host: "rsvp.kupernet.com", "x-forwarded-for": ip });

function fresh(seed, opts) { fake = createFakeSupabase(seed, opts); stub.reset(); return fake; }

const goodEvent = (over = {}) => ({
  event_type: "bar_mitzvah", event_name: "Party", gregorian_date: FUTURE, event_time: "19:00",
  location: "Hall", address: "1 Fake St", customer_name: "Dana Cohen", customer_email: "dana@example.test", ...over,
});
async function post(handler, body, headers, query = {}) {
  const res = makeRes();
  await handler({ method: "POST", query, headers, body }, res);
  return res;
}

const DRAFT_PW = "draft-fake-1";   // fake test values, held in constants
const HOSTILE = '"><img src=x onerror=alert(1)><script>alert(2)</script>';

// ---------- escaping ----------
test("create-event: hostile names never reach the e-mail body raw, subjects stay one line", async () => {
  fresh();
  const res = await post(createEvent, goodEvent({ customer_name: HOSTILE, event_name: HOSTILE + "\r\nBcc: x@example.test" }), H());
  assert.equal(res.statusCode, 200);
  assert.equal(stub.mails.length, 1);
  const m = stub.mails[0];
  assert.ok(!/<img|<script/i.test(m.htmlContent), m.htmlContent);
  assert.ok(m.htmlContent.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!/[\r\n]/.test(m.subject));
});

test("capture: hostile fields are escaped in the buyer's and the owner's e-mails, and in the failed-payment alert", async () => {
  fresh({ events: [{ id: 1, slug: "bm-cohen-2027", customer_name: "Dana", customer_email: "dana@example.test", event_type: "bar_mitzvah", event_name: "Draft", gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "x", dashboard_password: DRAFT_PW, paid_at: null, active: true }] });
  stub.order = approvedOrder(makeCustomId("bm-cohen-2027"));
  stub.capture = completedCapture();
  const b = { orderID: "ORDER-FAKE-0001", slug: "bm-cohen-2027", ...goodEvent({ customer_name: HOSTILE, event_name: HOSTILE, location: HOSTILE, customer_phone: HOSTILE, extra_note: HOSTILE }) };
  const res = await post(capture, b, H());
  assert.equal(res.statusCode, 200);
  assert.ok(stub.mails.length >= 3, "confirmation, receipt, owner notification");
  for (const m of stub.mails) assert.ok(!/<img|<script/i.test(m.htmlContent), m.subject + ": " + m.htmlContent);
  assert.ok(stub.mails.every((m) => !/[\r\n]/.test(m.subject)));

  // failed payment alert
  fresh({ events: [{ id: 1, slug: "bm-cohen-2027", customer_name: "Dana", customer_email: "dana@example.test", event_type: "bar_mitzvah", event_name: "Draft", gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "x", dashboard_password: DRAFT_PW, paid_at: null, active: true }] });
  stub.order = approvedOrder(makeCustomId("bm-cohen-2027"));
  stub.capture = { name: HOSTILE, details: [{ issue: HOSTILE, description: HOSTILE }], debug_id: HOSTILE };
  const bad = await post(capture, b, H());
  assert.equal(bad.statusCode, 400);
  assert.equal(stub.mails.length, 1);
  assert.ok(!/<img|<script/i.test(stub.mails[0].htmlContent));
});

test("_mail.esc is the one escaper: _recovery re-exports it", () => {
  assert.equal(recovery.esc, mail.esc);
  assert.equal(mail.esc(`<>&"'\``), "&lt;&gt;&amp;&quot;&#39;&#96;");
  assert.equal(mail.esc(null), "");
});

// ---------- limits: create-event ----------
test("create-event: the 4th request for one e-mail address in an hour gets 429 and sends nothing", async () => {
  fresh();
  for (let i = 0; i < 3; i++) assert.equal((await post(createEvent, goodEvent(), H(`198.51.100.${i}`))).statusCode, 200);
  const mails = stub.mails.length, rows = fake.store.events.length;
  const res = await post(createEvent, goodEvent(), H("198.51.100.99"));
  assert.equal(res.statusCode, 429);
  assert.equal(stub.mails.length, mails, "no mail");
  assert.equal(fake.store.events.length, rows, "no draft");
  // address matching is case-insensitive
  assert.equal((await post(createEvent, goodEvent({ customer_email: "DANA@example.test" }), H("198.51.100.98"))).statusCode, 429);
  // another address is fine
  assert.equal((await post(createEvent, goodEvent({ customer_email: "other@example.test" }), H("198.51.100.97"))).statusCode, 200);
});

test("create-event: the 21st request from one IP in an hour gets 429", async () => {
  fresh();
  for (let i = 0; i < 20; i++) assert.equal((await post(createEvent, goodEvent({ customer_email: `p${i}@example.test` }), H("192.0.2.10"))).statusCode, 200, "call " + i);
  assert.equal((await post(createEvent, goodEvent({ customer_email: "p99@example.test" }), H("192.0.2.10"))).statusCode, 429);
  assert.equal((await post(createEvent, goodEvent({ customer_email: "p98@example.test" }), H("192.0.2.11"))).statusCode, 200, "another IP is unaffected");
});

test("callers without an Origin header get a quarter of the limits (5 per IP, 1 per e-mail)", async () => {
  fresh();
  assert.equal((await post(createEvent, goodEvent({ customer_email: "q@example.test" }), NO_ORIGIN("192.0.2.20"))).statusCode, 200);
  assert.equal((await post(createEvent, goodEvent({ customer_email: "q@example.test" }), NO_ORIGIN("192.0.2.21"))).statusCode, 429, "2nd mail to one address");
  fresh();
  for (let i = 0; i < 5; i++) assert.equal((await post(createEvent, goodEvent({ customer_email: `n${i}@example.test` }), NO_ORIGIN("192.0.2.22"))).statusCode, 200);
  assert.equal((await post(createEvent, goodEvent({ customer_email: "n9@example.test" }), NO_ORIGIN("192.0.2.22"))).statusCode, 429);
  assert.equal((await post(createEvent, goodEvent({ customer_email: "n8@example.test" }), H("192.0.2.22"))).statusCode, 200, "a browser from the same IP still has budget");
});

test("a foreign Origin is refused with 403 on every public POST, with no database or PayPal call", async () => {
  fresh();
  const foreign = { origin: "https://evil.example", host: "rsvp.kupernet.com", "x-forwarded-for": "192.0.2.30" };
  assert.equal((await post(createEvent, goodEvent(), foreign)).statusCode, 403);
  assert.equal((await post(createOrder, { slug: "", password: "" }, foreign)).statusCode, 403);
  assert.equal((await post(capture, { orderID: "ORDER-FAKE-0001" }, foreign)).statusCode, 403);
  assert.equal((await post(capture, { checkoutId: "chk-12345678" }, foreign, { pending: "1" })).statusCode, 403);
  assert.equal((await post(createEvent, goodEvent(), { ...foreign, origin: "null" })).statusCode, 403, "an unparsable Origin is a mismatch");
  assert.equal(fake.calls.length, 0);
  assert.equal(stub.calls.length, 0);
  assert.equal(stub.mails.length, 0);
});

test("the counter fails open: a missing function (migration not run) or an error never blocks a buyer", async () => {
  fresh({}, { migrated: false });
  for (let i = 0; i < 6; i++) assert.equal((await post(createEvent, goodEvent(), H("192.0.2.40"))).statusCode, 200, "unmigrated, call " + i);
  fresh({}, { rpc: { rate_limit_hit: () => ({ data: null, error: { code: "XX000", message: "boom" } }) } });
  for (let i = 0; i < 6; i++) assert.equal((await post(createEvent, goodEvent(), H("192.0.2.41"))).statusCode, 200, "rpc error, call " + i);
  fresh({}, { rpc: { rate_limit_hit: () => { throw new Error("rpc exploded"); } } });
  assert.equal((await post(createEvent, goodEvent(), H("192.0.2.42"))).statusCode, 200);
});

test("counter keys are hashes: no raw IP address or e-mail address is stored", async () => {
  fresh();
  await post(createEvent, goodEvent({ customer_email: "private.person@example.test" }), H("192.0.2.50"));
  const keys = fake.store.rate_limits.map((r) => r.key);
  assert.ok(keys.length >= 2);
  for (const k of keys) { assert.ok(!k.includes("192.0.2.50")); assert.ok(!k.includes("private.person")); }
});

// ---------- limits: pending beacon ----------
const pendingBody = (over = {}) => ({ checkoutId: "chk-12345678", customer_name: "Dana", customer_email: "dana@example.test", event_name: "Party", ...over });

test("pending: the checkoutId must be a plain 8-64 char token, fields are capped at 200 chars", async () => {
  fresh();
  for (const id of ["short", "has space 12345", "a".repeat(65), "../../etc/pass", undefined, 12345678]) {
    assert.equal((await post(capture, pendingBody({ checkoutId: id }), H("192.0.2.60"), { pending: "1" })).statusCode, 400, String(id));
  }
  assert.equal(fake.store.pending_checkouts.length, 0);
  const res = await post(capture, pendingBody({ event_name: "x".repeat(500), location: "y".repeat(300) }), H("192.0.2.60"), { pending: "1" });
  assert.equal(res.statusCode, 200);
  const row = fake.store.pending_checkouts[0];
  assert.equal(row.event_name.length, 200);
  assert.equal(row.location.length, 200);
});

test("pending: 3 per e-mail per day, 30 per IP per hour", async () => {
  fresh();
  for (let i = 0; i < 3; i++) assert.equal((await post(capture, pendingBody({ checkoutId: "chk-1234567" + i }), H("192.0.2.61"), { pending: "1" })).statusCode, 200);
  const res = await post(capture, pendingBody({ checkoutId: "chk-12345679" }), H("192.0.2.62"), { pending: "1" });
  assert.equal(res.statusCode, 429);
  assert.equal(fake.store.pending_checkouts.length, 3, "the 4th was not stored");
  fresh();
  for (let i = 0; i < 30; i++) assert.equal((await post(capture, pendingBody({ checkoutId: "chk-id-" + String(i).padStart(4, "0"), customer_email: `v${i}@example.test` }), H("192.0.2.63"), { pending: "1" })).statusCode, 200, "call " + i);
  assert.equal((await post(capture, pendingBody({ checkoutId: "chk-id-9999", customer_email: "v99@example.test" }), H("192.0.2.63"), { pending: "1" })).statusCode, 429);
});

// ---------- limits: capture and create-order ----------
test("capture: the 21st call from one IP in an hour is refused with 400 before any PayPal call", async () => {
  fresh();
  stub.order = approvedOrder("not-signed");
  for (let i = 0; i < 20; i++) assert.equal((await post(capture, { orderID: "ORDER-FAKE-0001", ...goodEvent() }, H("192.0.2.70"))).statusCode, 400);
  const before = stub.calls.length;
  const res = await post(capture, { orderID: "ORDER-FAKE-0001", ...goodEvent() }, H("192.0.2.70"));
  assert.equal(res.statusCode, 400);
  assert.equal(stub.calls.length, before, "the refused call made no PayPal request");
});

test("create-order: 20 per IP per hour, and 10 attempts per IP+slug per hour (password guessing)", async () => {
  fresh({ events: [{ id: 1, slug: "bm-cohen-2027", dashboard_password: DRAFT_PW, paid_at: null }] });
  const WRONG = "wrong-fake-1";
  for (let i = 0; i < 10; i++) assert.equal((await post(createOrder, { slug: "bm-cohen-2027", password: WRONG }, H("192.0.2.80"))).statusCode, 403);
  assert.equal((await post(createOrder, { slug: "bm-cohen-2027", password: WRONG }, H("192.0.2.80"))).statusCode, 429);
  assert.equal((await post(createOrder, { slug: "bm-cohen-2027", password: DRAFT_PW }, H("192.0.2.80"))).statusCode, 429, "the right password does not pass once the guess budget is spent");
  assert.equal((await post(createOrder, { slug: "bm-cohen-2027", password: DRAFT_PW }, H("192.0.2.81"))).statusCode, 200, "another IP is unaffected");
  fresh();
  for (let i = 0; i < 20; i++) assert.equal((await post(createOrder, {}, H("192.0.2.82"))).statusCode, 200);
  assert.equal((await post(createOrder, {}, H("192.0.2.82"))).statusCode, 429);
});

// ---------- cleanup ----------
test("cleanup purges counter rows older than a day, keeps recent ones, and survives a missing table", async () => {
  fresh({ rate_limits: [
    { key: "old", window_start: new Date(Date.now() - 2 * 864e5).toISOString(), hits: 3 },
    { key: "new", window_start: new Date().toISOString(), hits: 1 },
  ] });
  const res = makeRes();
  await cleanup({ headers: { authorization: "Bearer fake-cron-secret" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(fake.store.rate_limits.map((r) => r.key), ["new"]);

  fresh({}, { migrated: false });
  const res2 = makeRes();
  await cleanup({ headers: { authorization: "Bearer fake-cron-secret" } }, res2);
  assert.equal(res2.statusCode, 200, "before the migration the purge is skipped, cleanup still works");
});

test("rate-limit unit: window expiry resets the count", async () => {
  fresh();
  const call = (limit) => fake.rpc("rate_limit_hit", { p_key: "k", p_window_s: 60, p_limit: limit });
  assert.equal((await call(2)).data, true);
  assert.equal((await call(2)).data, true);
  assert.equal((await call(2)).data, false);
  fake.store.rate_limits[0].window_start = new Date(Date.now() - 61000).toISOString();
  assert.equal((await call(2)).data, true);
});
