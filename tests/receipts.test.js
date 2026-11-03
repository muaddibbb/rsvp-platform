"use strict";
// Receipts and refunds (release two): the receipt number is stored once (gapless counter), the receipt shows
// the ORIGINAL payment date in Israel time, the admin download and the e-mailed copy are built by the same
// helper, and the refund marker (refunded_at) is set and cleared without touching `active`.
// Everything also has to work BEFORE the owner runs sql/release-two-migration.sql (fake opts.migrated=false).
// Offline: Brevo/PayPal stubbed, Supabase is the in-memory fake.
process.env.TZ = "America/Los_Angeles";   // not Israel: a date that follows the server zone would be wrong
process.env.PAYPAL_CLIENT_ID = "fake-client-id";
process.env.PAYPAL_SECRET = "fake-paypal-secret-value";
process.env.PAYPAL_SANDBOX = "true";
process.env.BREVO_API_KEY = "fake-brevo-key-value";
process.env.ADMIN_PASSWORD = "fake-admin-pass";
delete process.env.ORDER_SIGNING_KEY;

const test = require("node:test");
require("./_quiet")(test);   // M-1: keep handler logging off the runner's result pipe
const assert = require("node:assert/strict");
const path = require("node:path");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");
const { installFetchStub, approvedOrder, completedCapture, makeCustomId } = require("./_paypal-stub");

// Spy on the PDF generator: same function object semantics, but every input is recorded.
const receiptPath = require.resolve("../api/_receipt");
const real = require("../api/_receipt");
const pdfInputs = [];
const spy = (input) => { pdfInputs.push({ ...input }); return real(input); };
Object.assign(spy, real);
require.cache[receiptPath].exports = spy;

const stub = installFetchStub();
let fake = createFakeSupabase();
install({ from: (t) => fake.from(t), rpc: (n, a) => fake.rpc(n, a) });
const capture = require("../api/paypal-capture");
const admin = require("../api/admin-events");
const { formatPaymentDate, buildReceipt } = real;

const FUTURE = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
const SITE = { origin: "https://rsvp.kupernet.com", host: "rsvp.kupernet.com", "x-forwarded-for": "203.0.113.9" };
const AUTH = { authorization: "Bearer fake-admin-pass" };

function ev(id, slug, paid_at, extra = {}) {
  return { id, slug, customer_name: "Buyer " + id, customer_email: `b${id}@example.test`, event_type: "bar_mitzvah", event_name: "Event " + id, gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "x", dashboard_password: "fake-pw-" + id, paid_at, active: true, ...extra };
}
function fresh(events, opts) {
  fake = createFakeSupabase({ events }, opts);
  stub.reset();
  pdfInputs.length = 0;
}
async function adminGet(query) {
  const res = makeRes();
  await admin({ method: "GET", query, headers: AUTH }, res);
  return res;
}
async function adminPatch(slug, body) {
  const res = makeRes();
  await admin({ method: "PATCH", query: { slug }, headers: AUTH, body }, res);
  return res;
}
async function pay(slug, extra = {}) {
  stub.order = approvedOrder(makeCustomId(slug));
  stub.capture = completedCapture();
  const res = makeRes();
  await capture({ method: "POST", query: {}, headers: SITE, body: { orderID: "ORDER-FAKE-0001", slug, customer_name: "Buyer", customer_email: "buyer@example.test", ...extra } }, res);
  return res;
}
const row = (slug) => fake.store.events.find((e) => e.slug === slug);

// ---------- the date ----------
test("receipt date = the stored payment time shown in Israel time, whatever the server zone", () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/Los_Angeles");
  assert.equal(formatPaymentDate("2026-11-02T22:30:00Z"), "3.11.2026", "winter: 22:30Z is already the 3rd in Israel");
  assert.equal(formatPaymentDate("2026-11-02T21:30:00Z"), "2.11.2026");
  assert.equal(formatPaymentDate("2026-07-15T21:30:00Z"), "16.7.2026", "summer (UTC+3)");
  assert.match(formatPaymentDate(null), /^\d{1,2}\.\d{1,2}\.\d{4}$/, "no timestamp: today");
  assert.match(formatPaymentDate("not a date"), /^\d{1,2}\.\d{1,2}\.\d{4}$/);
});

test("a receipt downloaded long after payment shows the original date, not today's", async () => {
  fresh([ev(1, "bm-a-2027", "2026-03-04T10:00:00Z")]);
  const res = await adminGet({ receipt: "1", slug: "bm-a-2027" });
  assert.equal(res.statusCode, 200);
  assert.equal(pdfInputs.at(-1).paymentDate, "4.3.2026");
});

// ---------- the number ----------
test("the receipt number is stable across calls and after deleting another event", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z", { receipt_number: 1 }), ev(2, "b", "2026-02-01T10:00:00Z", { receipt_number: 2 }), ev(3, "c", "2026-03-01T10:00:00Z", { receipt_number: 3 })]);
  const nums = async () => { pdfInputs.length = 0; for (const s of ["a", "b", "c"].filter((x) => row(x))) await adminGet({ receipt: "1", slug: s }); return pdfInputs.map((i) => i.receiptNumber); };
  assert.deepEqual(await nums(), [1, 2, 3]);
  assert.deepEqual(await nums(), [1, 2, 3], "same on the second download");
  // delete event a through the real admin handler
  const del = makeRes();
  await admin({ method: "DELETE", query: { slug: "a" }, headers: AUTH }, del);
  assert.equal(del.statusCode, 200);
  assert.deepEqual(await nums(), [2, 3], "the others keep their numbers (the old count rule would have said 1, 2)");
});

test("deleting the newest event never reuses its number (counter, not a count)", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z"), ev(2, "d", null)]);
  const first = await pay("d");
  assert.equal(first.statusCode, 200);
  assert.equal(row("d").receipt_number, 1);
  // delete it, then a new customer pays
  const del = makeRes();
  await admin({ method: "DELETE", query: { slug: "d" }, headers: AUTH }, del);
  fake.store.events.push(ev(5, "e", null));
  const second = await pay("e");
  assert.equal(second.statusCode, 200);
  assert.equal(row("e").receipt_number, 2, "number 1 is not given out again");
});

test("assign_receipt_number is idempotent and numbers only paid events", async () => {
  fresh([ev(1, "paid", "2026-01-01T10:00:00Z"), ev(2, "draft", null)]);
  assert.equal((await fake.rpc("assign_receipt_number", { p_slug: "paid" })).data, 1);
  assert.equal((await fake.rpc("assign_receipt_number", { p_slug: "paid" })).data, 1);
  assert.equal((await fake.rpc("assign_receipt_number", { p_slug: "draft" })).data, null);
  assert.equal(row("draft").receipt_number, undefined);
  assert.equal(fake.store.receipt_counter[0].last_number, 1);
});

test("old rows without a number get one on first download (lazy), in the same call the PDF uses", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z"), ev(2, "b", "2026-02-01T10:00:00Z")]);
  await adminGet({ receipt: "1", slug: "b" });
  assert.equal(row("b").receipt_number, 1, "numbered on demand");
  assert.equal(pdfInputs.at(-1).receiptNumber, 1);
  await adminGet({ receipt: "1", slug: "b" });
  assert.equal(pdfInputs.at(-1).receiptNumber, 1, "and unchanged afterwards");
});

// ---------- e-mailed copy and admin copy agree ----------
test("the e-mailed receipt and the admin download are built from the same inputs", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z", { receipt_number: 1 }), ev(2, "mine", null, { customer_name: "Dana Cohen" })]);
  const paid = await pay("mine", { customer_name: "Dana Cohen" });
  assert.equal(paid.statusCode, 200);
  const mailInput = pdfInputs.at(-1);
  assert.equal(mailInput.receiptNumber, 2);
  const mail = stub.mails.find((m) => m.attachment);
  assert.ok(mail.subject.includes("000002"));
  assert.ok(mail.attachment[0].name.includes("000002"));

  pdfInputs.length = 0;
  const res = await adminGet({ receipt: "1", slug: "mine" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(pdfInputs.at(-1), mailInput, "same number, name, date, isRefund");
  assert.equal(mailInput.paymentDate, formatPaymentDate(row("mine").paid_at));
});

// ---------- before the migration ----------
test("before the migration: no RPC, no column: the old count rule gives the same numbers, correct date", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z"), ev(2, "b", "2026-02-01T10:00:00Z"), ev(3, "c", "2026-03-04T10:00:00Z"), ev(4, "draft", null)], { migrated: false });
  const got = [];
  for (const s of ["a", "b", "c"]) {
    const res = await adminGet({ receipt: "1", slug: s });
    assert.equal(res.statusCode, 200, s);
    got.push(pdfInputs.at(-1));
  }
  assert.deepEqual(got.map((i) => i.receiptNumber), [1, 2, 3], "1..n in paid_at order, like the backfill");
  assert.equal(got[2].paymentDate, "4.3.2026");
  assert.ok(fake.rpcCalls.every((c) => c.name === "assign_receipt_number"));
});

test("before the migration a new payment still publishes, e-mails a receipt, and returns 200", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z"), ev(2, "mine", null)], { migrated: false });
  const res = await pay("mine");
  assert.equal(res.statusCode, 200);
  assert.equal(pdfInputs.at(-1).receiptNumber, 2);
  assert.ok(stub.mails.some((m) => m.attachment && m.subject.includes("000002")));
});

test("an RPC that errors falls back to the count and the page still works", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z"), ev(2, "b", "2026-02-01T10:00:00Z")], { rpc: { assign_receipt_number: () => ({ data: null, error: { code: "XX000", message: "boom" } }) } });
  const res = await adminGet({ receipt: "1", slug: "b" });
  assert.equal(res.statusCode, 200);
  assert.equal(pdfInputs.at(-1).receiptNumber, 2);
});

test("buildReceipt reuses the stored number without any RPC", async () => {
  fresh([]);
  const r = await buildReceipt(fake, { slug: "x", customer_name: "N", paid_at: "2026-01-01T10:00:00Z", receipt_number: 7 });
  assert.equal(r.receiptNumber, 7);
  assert.equal(fake.rpcCalls.length, 0);
});

// ---------- refunds ----------
test("refund PDF reuses the receipt number and is dated refunded_at (else today)", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z", { receipt_number: 5, refunded_at: "2026-05-06T10:00:00Z" })]);
  const res = await adminGet({ refund: "1", slug: "a" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(pdfInputs.at(-1), { receiptNumber: 5, customerName: "Buyer 1", paymentDate: "6.5.2026", isRefund: true });
  fresh([ev(1, "a", "2026-01-01T10:00:00Z", { receipt_number: 5 })]);
  await adminGet({ refund: "1", slug: "a" });
  assert.equal(pdfInputs.at(-1).receiptNumber, 5);
  assert.equal(pdfInputs.at(-1).paymentDate, formatPaymentDate(null));
  await adminGet({ receipt: "1", slug: "a" });
  assert.equal(pdfInputs.at(-1).paymentDate, "1.1.2026", "the normal receipt keeps the payment date");
});

test("PATCH {refunded:true} sets refunded_at and leaves active alone; {refunded:false} clears it", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z", { active: true }), ev(2, "b", "2026-01-02T10:00:00Z", { active: false })]);
  let res = await adminPatch("a", { refunded: true });
  assert.equal(res.statusCode, 200);
  assert.ok(row("a").refunded_at);
  assert.equal(row("a").active, true);
  res = await adminPatch("b", { refunded: true });
  assert.equal(row("b").active, false, "a deactivated event stays deactivated, an active one stays active");
  res = await adminPatch("a", { refunded: false });
  assert.equal(res.statusCode, 200);
  assert.equal(row("a").refunded_at, null);
  assert.equal(row("a").active, true);
});

test("PATCH with neither field is refused and does not deactivate (missing `active` is not false)", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z", { active: true })]);
  assert.equal((await adminPatch("a", {})).statusCode, 400);
  assert.equal((await adminPatch("a", undefined)).statusCode, 400);
  assert.equal((await adminPatch("a", { refunded: "yes" })).statusCode, 400);
  assert.equal(row("a").active, true);
  assert.equal((await adminPatch("a", { active: false })).statusCode, 200);
  assert.equal(row("a").active, false, "the existing active toggle still works");
  assert.equal((await adminPatch("nope", { refunded: true })).statusCode, 404);
});

test("PATCH needs the admin password", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z")]);
  const res = makeRes();
  await admin({ method: "PATCH", query: { slug: "a" }, headers: { authorization: "Bearer wrong-value" }, body: { refunded: true } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(row("a").refunded_at, undefined);
});

test("before the migration, marking a refund answers 409 'migration needed' and changes nothing", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z")], { migrated: false });
  const res = await adminPatch("a", { refunded: true });
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /migration/i);
  assert.equal(row("a").refunded_at, undefined);
});

test("the admin list loads before and after the migration; after it carries the new fields", async () => {
  fresh([ev(1, "a", "2026-01-01T10:00:00Z", { receipt_number: 1, refunded_at: "2026-02-01T00:00:00Z" }), ev(2, "b", "2026-01-02T10:00:00Z", { receipt_number: 2 })]);
  let res = await adminGet({});
  assert.equal(res.statusCode, 200);
  const byslug = Object.fromEntries(res.body.events.map((e) => [e.slug, e]));
  assert.equal(byslug.a.receipt_number, 1);
  assert.ok(byslug.a.refunded_at);
  assert.ok(!byslug.b.refunded_at);

  fresh([ev(1, "a", "2026-01-01T10:00:00Z"), ev(2, "b", "2026-01-02T10:00:00Z")], { migrated: false });
  res = await adminGet({});
  assert.equal(res.statusCode, 200, "retried with the old column list");
  assert.equal(res.body.events.length, 2);
  assert.ok(res.body.events.every((e) => e.refunded_at === undefined));
  const sels = fake.calls.filter((c) => c.table === "events" && c.op === "select").map((c) => c.cols);
  assert.ok(sels[0].includes("refunded_at") && !sels[1].includes("refunded_at"));
});

test("the receipt/refund GET answers 404 for an unknown slug and 400 for an unpaid one", async () => {
  fresh([ev(1, "draft", null)]);
  assert.equal((await adminGet({ receipt: "1", slug: "nope" })).statusCode, 404);
  assert.equal((await adminGet({ receipt: "1", slug: "draft" })).statusCode, 400);
});
