"use strict";
// J-05: an invalid PayPal order id is refused (400) before any PayPal or database call.
// J-18: /api/paypal-config returns only the client id, even with ?test=1 and a valid admin bearer.
// Offline: fetch is stubbed and counted, Supabase is the in-memory fake.
const fetchCalls = [];
global.fetch = async (...args) => { fetchCalls.push(args); throw new Error("network is blocked in tests"); };
process.env.PAYPAL_CLIENT_ID = "fake-client-id";
process.env.PAYPAL_SECRET = "fake-paypal-secret-value";
process.env.ADMIN_PASSWORD = "fake-admin-pass";
process.env.PAYPAL_SANDBOX = "true";
delete process.env.BREVO_API_KEY;

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");

const fake = createFakeSupabase();
install(fake);
const capture = require("../api/paypal-capture");
const config = require("../api/paypal-config");

const future = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);

test("invalid order ids are refused with 400 and no fetch / query happens", async () => {
  const bad = ["../..", "../../v1/oauth2/token", "abc?x=1", "abc#frag", "", "short", "a".repeat(200), "has space 1234", "ab/cd/efgh", "id%2e%2e1234", 12345678, { a: 1 }, ["ABCDEFGH"]];
  for (const orderID of bad) {
    const res = makeRes();
    await capture({ method: "POST", query: {}, headers: {}, body: { orderID, slug: "x", gregorian_date: future } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(orderID));
  }
  assert.equal(fetchCalls.length, 0, "no PayPal call before the id is validated");
  assert.equal(fake.calls.length, 0, "no database call either");
});

test("a well-formed id passes the format check (and then is judged by the later checks)", async () => {
  const res = makeRes();
  fetchCalls.length = 0;
  await capture({ method: "POST", query: {}, headers: {}, body: { orderID: "5O190127TN364715T", gregorian_date: future } }, res);
  // the id was accepted by the format check: the handler went on (the stubbed network then fails closed)
  assert.ok(fetchCalls.length > 0 || res.statusCode !== 400 || res.body.error !== "מזהה הזמנה לא תקין");
});

test("paypal-config returns only the client id, also with ?test=1 and an admin bearer", async () => {
  fetchCalls.length = 0;
  const res = makeRes();
  await config({ method: "GET", query: { test: "1" }, headers: { authorization: "Bearer fake-admin-pass" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { clientId: "fake-client-id" });
  assert.equal(fetchCalls.length, 0);
  assert.ok(!JSON.stringify(res.body).includes("fake-paypal-secret-value"));
});

test("paypal-config source has no token call and no test branch", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "api", "paypal-config.js"), "utf8");
  assert.ok(!/oauth2\/token|req\.query|PAYPAL_SECRET|authorized/.test(src));
});
