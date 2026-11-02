"use strict";
// Flow test for the abandoned-checkout sweep (api/_sweep.js): a buyer who already paid is skipped (no
// recovery email, no anonymous log row, not counted; closes J2-05), and a failed checkout_abandonments
// insert is logged and shown in the owner digest. Runs the real code against the in-memory fake Supabase
// (tests/_fake-supabase.js) and a stubbed Brevo endpoint. No network, no real database.
process.env.BREVO_API_KEY = "fake-brevo-key";
process.env.BASE_URL = "https://rsvp.example.invalid";
const BREVO = "https://api.brevo.com/v3/smtp/email";
const fetchCalls = [];
const allUrls = []; // never reset: every URL any test asked for
global.fetch = async (url, init = {}) => {
  fetchCalls.push({ url, init });
  allUrls.push(url);
  if (url === BREVO) return { ok: true, status: 201, json: async () => ({}) };
  throw new Error("network is blocked in tests: " + url);
};

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFakeSupabase, install } = require("./_fake-supabase");

const fake = createFakeSupabase({});
install(fake);
const { sweepAbandonedCheckouts } = require("../api/_sweep");

const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function pending(id, email) {
  return {
    id, customer_name: "Fake " + id, customer_email: email, customer_phone: "0500000000",
    event_name: "Event " + id, event_type: "bar_mitzvah", gregorian_date: "2027-01-15",
    updated_at: ago(HOUR), notified: false,
  };
}
function reset({ pendingRows = [], eventRows = [] } = {}) {
  fake.store.pending_checkouts = pendingRows;
  fake.store.events = eventRows;
  fake.store.checkout_abandonments = [];
  fetchCalls.length = 0;
}
const brevoMails = () => fetchCalls
  .filter((c) => c.url === BREVO)
  .map((c) => { const b = JSON.parse(c.init.body); return { to: b.to[0].email, subject: b.subject, html: b.htmlContent }; });

test("J2-05 sweep skips an already-paid buyer", async () => {
  reset({
    pendingRows: [pending(1, "a@example.test"), pending(2, "b@example.test")],
    eventRows: [{ id: 10, slug: "a-event", event_name: "Event 1", customer_email: "a@example.test", gregorian_date: "2027-01-15", paid_at: ago(5 * 60 * 1000), active: true }],
  });
  const n = await sweepAbandonedCheckouts();
  assert.equal(n, 1);
  const mails = brevoMails();
  assert.equal(mails.length, 2);
  assert.ok(mails.some((m) => m.to === "b@example.test"), "recovery email to b");
  assert.ok(mails.some((m) => m.to === "kuperoy@gmail.com"), "owner digest");
  assert.ok(!mails.some((m) => m.to === "a@example.test"), "no email to the buyer who paid");
  assert.equal(fake.store.checkout_abandonments.length, 1);
  assert.deepEqual(Object.keys(fake.store.checkout_abandonments[0]).sort(), ["abandoned_at", "event_type", "id"]);
  assert.ok(fake.store.pending_checkouts.every((r) => r.notified === true));
  const digest = mails.find((m) => m.to === "kuperoy@gmail.com");
  assert.ok(digest.subject.includes("1 לקוח"));
  assert.ok(digest.html.includes("(עוד לקוח אחד השלים תשלום מאוחר יותר ולא נספר)"));
  assert.ok(!digest.html.includes("לא נשמרו ביומן הנטישות"), "no warning when every insert worked");
});

test("failed checkout_abandonments insert is logged and shown in the digest", async () => {
  reset({ pendingRows: [pending(3, "c@example.test")] });
  const realFrom = fake.from;
  const realError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args); };
  fake.from = (table) => {
    if (table !== "checkout_abandonments") return realFrom.call(fake, table);
    const failed = { data: null, error: { code: "PGRST205", message: "Could not find the table" } };
    return { insert() { return { then: (resolve, reject) => Promise.resolve(failed).then(resolve, reject) }; } };
  };
  let n;
  try {
    n = await sweepAbandonedCheckouts();
  } finally {
    fake.from = realFrom;
    console.error = realError;
  }
  assert.equal(n, 1, "return value unchanged");
  const digest = brevoMails().find((m) => m.to === "kuperoy@gmail.com");
  assert.ok(digest, "the digest is still sent");
  assert.ok(digest.html.includes("לא נשמרו ביומן הנטישות"));
  assert.ok(digest.html.includes("1 מתוך 1"));
  assert.ok(errors.some((a) => a[0] === "checkout_abandonments insert error:" && a[1] === "PGRST205"), "the failure is logged");
  assert.equal(fake.store.checkout_abandonments.length, 0);
  assert.ok(fake.store.pending_checkouts.every((r) => r.notified === true));
});

test("no pending rows returns 0 and sends nothing", async () => {
  reset();
  const n = await sweepAbandonedCheckouts();
  assert.equal(n, 0);
  assert.equal(fetchCalls.length, 0);
  assert.equal(fake.store.checkout_abandonments.length, 0);
});

test("no network call besides the Brevo stub", () => {
  assert.ok(allUrls.length > 0);
  assert.ok(allUrls.every((u) => u === BREVO));
});
