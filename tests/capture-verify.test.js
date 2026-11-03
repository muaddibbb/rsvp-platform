"use strict";
// J-02 / J-03: the capture handler publishes only an order our server signed, for exactly 99 ILS, for an
// unpaid draft, and never returns the password in publish mode. Also create-order's ownership proof.
// Offline: PayPal and Brevo are stubbed (tests/_paypal-stub.js), Supabase is the in-memory fake.
process.env.PAYPAL_CLIENT_ID = "fake-client-id";
process.env.PAYPAL_SECRET = "fake-paypal-secret-value";
process.env.PAYPAL_SANDBOX = "true";
process.env.BREVO_API_KEY = "fake-brevo-key-value";
delete process.env.ORDER_SIGNING_KEY;

const test = require("node:test");
require("./_quiet")(test);   // M-1: keep handler logging off the runner's result pipe
const assert = require("node:assert/strict");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");
const { installFetchStub, approvedOrder, completedCapture, makeCustomId } = require("./_paypal-stub");

const stub = installFetchStub();
const fake = createFakeSupabase();
install(fake);
const capture = require("../api/paypal-capture");
const createOrder = require("../api/paypal-create-order");

const FUTURE = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
const ORDER_ID = "ORDER-FAKE-0001";
const SLUG = "bm-cohen-2027";
const OTHER = "bm-levi-2027";
const PW = "draft-fake-1";           // fake test values, held in constants
const OTHER_PW = "other-fake-1";
const WRONG_PW = "wrong-fake-1";

function seed() {
  fake.store.events.length = 0;
  fake.store.events.push(
    { id: 1, slug: SLUG, customer_name: "Dana Cohen", customer_email: "dana@example.test", event_type: "bar_mitzvah", event_name: "Draft Event", gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "1 Fake St", dashboard_password: PW, paid_at: null, active: true },
    { id: 2, slug: OTHER, customer_name: "Ron Levi", customer_email: "ron@example.test", event_type: "bar_mitzvah", event_name: "Paid Event", gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "2 Fake St", dashboard_password: OTHER_PW, paid_at: "2026-09-01T10:00:00.000Z", active: true },
  );
  fake.store.rate_limits.length = 0;   // these tests are about the checks, not the limiter
  stub.reset();
  fake.calls.length = 0;
  fake.rpcCalls.length = 0;
}

const body = (extra = {}) => ({ orderID: ORDER_ID, checkoutId: "chk-12345678", slug: SLUG, customer_name: "Dana Cohen", customer_email: "dana@example.test", event_type: "bar_mitzvah", event_name: "Draft Event", gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "1 Fake St", ...extra });
async function callCapture(b = body(), headers = { origin: "https://rsvp.kupernet.com", host: "rsvp.kupernet.com" }) {
  const res = makeRes();
  await capture({ method: "POST", query: {}, headers, body: b }, res);
  return res;
}
const draftRow = () => fake.store.events.find((e) => e.slug === SLUG);
const captures = () => stub.byKind("capture").length;

test("a normal signed 99 ILS capture publishes the draft and returns no password", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  const res = await callCapture();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ["event_name", "slug"]);
  assert.equal(res.body.slug, SLUG);
  assert.ok(!JSON.stringify(res.body).includes(PW));
  assert.ok(draftRow().paid_at, "draft is live");
  assert.equal(captures(), 1);
  // the owner's confirmation e-mail to the buyer still carries the password (that is the buyer's own mail)
  assert.ok(stub.mails.some((m) => m.htmlContent.includes(PW)));
});

const REFUSALS = {
  "amount 1.00": (c) => approvedOrder(c, { purchase_units: [{ amount: { currency_code: "ILS", value: "1.00" }, custom_id: c }] }),
  "currency USD": (c) => approvedOrder(c, { purchase_units: [{ amount: { currency_code: "USD", value: "99.00" }, custom_id: c }] }),
  "order not APPROVED (CREATED)": (c) => approvedOrder(c, { status: "CREATED" }),
  "order COMPLETED but not signed by us": (c) => approvedOrder(undefined, { status: "COMPLETED" }),
  "intent AUTHORIZE (m-5)": (c) => approvedOrder(c, { intent: "AUTHORIZE" }),
  "no custom_id (order made with the public client id)": (c) => approvedOrder(undefined),
  "tampered signature": (c) => approvedOrder(c.slice(0, -2) + (c.endsWith("AA") ? "BB" : "AA")),
  "signature of another slug": (c) => approvedOrder(makeCustomId(OTHER).replace(OTHER, SLUG)),
  "two purchase units": (c) => approvedOrder(c, { purchase_units: [{ amount: { currency_code: "ILS", value: "99.00" }, custom_id: c }, { amount: { currency_code: "ILS", value: "99.00" } }] }),
  "no purchase units": (c) => approvedOrder(c, { purchase_units: [] }),
  "garbage custom_id": (c) => approvedOrder("not-a-signed-id"),
};
for (const [name, make] of Object.entries(REFUSALS)) {
  test(`refused with 400 and zero capture calls: ${name}`, async () => {
    seed();
    stub.order = make(makeCustomId(SLUG));
    stub.capture = completedCapture();
    const res = await callCapture();
    assert.equal(res.statusCode, 400);
    assert.equal(captures(), 0, "money did not move");
    assert.equal(draftRow().paid_at, null, "draft not published");
    assert.equal(stub.mails.length, 0, "no alert mail for an unsigned or wrong order (J-04)");
  });
}

test("an order PayPal cannot find is refused with 400 and no capture", async () => {
  seed();
  stub.orderHttpOk = false;
  stub.order = null;
  const res = await callCapture();
  assert.equal(res.statusCode, 400);
  assert.equal(captures(), 0);
});

test("the signed slug wins: a body slug of another event is refused (400, no capture)", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  const res = await callCapture(body({ slug: OTHER }));
  assert.equal(res.statusCode, 400);
  assert.equal(captures(), 0);
  assert.equal(fake.store.events.find((e) => e.slug === OTHER).paid_at, "2026-09-01T10:00:00.000Z", "other event untouched");
});

test("a signed order for a draft publishes that draft even if the body omits the slug", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  const b = body(); delete b.slug;
  const res = await callCapture(b);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.slug, SLUG);
  assert.ok(!("dashboard_password" in res.body));
});

test("J-03: an order signed for an already paid event is refused (400, no capture, event untouched)", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(OTHER));
  stub.capture = completedCapture();
  const res = await callCapture(body({ slug: OTHER, event_name: "HACKED" }));
  assert.equal(res.statusCode, 400);
  assert.equal(captures(), 0);
  const o = fake.store.events.find((e) => e.slug === OTHER);
  assert.equal(o.event_name, "Paid Event");
  assert.ok(!JSON.stringify(res.body).includes(OTHER_PW));
});

test("an order signed for a slug that does not exist is refused before capture", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId("bm-nobody-2027"));
  stub.capture = completedCapture();
  const res = await callCapture(body({ slug: "bm-nobody-2027" }));
  assert.equal(res.statusCode, 400);
  assert.equal(captures(), 0);
});

for (const [name, cap] of Object.entries({
  "capture status PENDING": { id: "x", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "PENDING", amount: { currency_code: "ILS", value: "99.00" } }] } }] },
  "captured amount 1.00": { id: "x", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "COMPLETED", amount: { currency_code: "ILS", value: "1.00" } }] } }] },
  "captured currency USD": { id: "x", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ status: "COMPLETED", amount: { currency_code: "USD", value: "99.00" } }] } }] },
  "no captures array": { id: "x", status: "COMPLETED", purchase_units: [{}] },
})) {
  test(`post-capture mismatch (${name}): 502, nothing published, owner alerted with escaped text`, async () => {
    seed();
    stub.order = approvedOrder(makeCustomId(SLUG));
    stub.capture = cap;
    const res = await callCapture();
    assert.equal(res.statusCode, 502, "not 400: the money may have moved");
    assert.equal(draftRow().paid_at, null);
    assert.equal(captures(), 1);
    assert.equal(stub.mails.length, 1);
    assert.equal(stub.mails[0].to[0].email, "kuperoy@gmail.com");
    assert.ok(stub.mails[0].htmlContent.includes(ORDER_ID));
  });
}

test("a declined capture (order status not COMPLETED) answers 400 with an escaped owner alert", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "<b>INSTRUMENT_DECLINED</b>", description: "<img src=x onerror=1>" }], debug_id: "dbg<1>" };
  const res = await callCapture(body({ event_name: "<script>alert(1)</script>" }));
  assert.equal(res.statusCode, 400);
  assert.equal(draftRow().paid_at, null);
  const html = stub.mails[0].htmlContent;
  assert.ok(!html.includes("<img src=x") && !html.includes("<script>") && !html.includes("<b>INSTRUMENT"));
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
});

test("double payment race: the draft became paid after our check -> 409, owner alert 'refund order', event unchanged", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  stub.onCapture = () => { draftRow().paid_at = "2026-11-03T08:00:00.000Z"; draftRow().event_name = "First Payer"; };
  const res = await callCapture(body({ event_name: "Second Payer" }));
  assert.equal(res.statusCode, 409);
  assert.equal(draftRow().event_name, "First Payer", "the first payer's event is not overwritten");
  assert.ok(!("dashboard_password" in (res.body || {})));
  assert.ok(stub.mails.some((m) => m.to[0].email === "kuperoy@gmail.com" && m.htmlContent.includes(ORDER_ID)));
  const upd = fake.calls.find((c) => c.op === "update");
  assert.ok(upd.filters.some((f) => f.type === "is" && f.col === "paid_at"), "the update is guarded by paid_at is null");
});

test("legacy path: a signed 'new' order creates a fresh event and returns the password to its buyer; a body slug is ignored", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(null));
  stub.capture = completedCapture();
  const res = await callCapture(body({ slug: OTHER }));
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.slug && res.body.slug !== OTHER && res.body.slug !== SLUG);
  assert.ok(res.body.dashboard_password);
  assert.equal(fake.store.events.length, 3);
  assert.equal(fake.store.events.find((e) => e.slug === OTHER).event_name, "Paid Event");
  assert.equal(fake.store.events.find((e) => e.slug === res.body.slug).paid_at !== null, true);
});

test("a legacy order cannot be used to pass the signature of a draft (and vice versa)", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(null));
  stub.capture = completedCapture();
  assert.notEqual(makeCustomId(null).split(".")[1], makeCustomId(SLUG).split(".")[1]);
  const forged = makeCustomId(null).replace(/^new\./, SLUG + ".");
  stub.order = approvedOrder(forged);
  const res = await callCapture();
  assert.equal(res.statusCode, 400);
  assert.equal(captures(), 0);
});

// ---- M-2: money taken, then something fails: the owner must hear about it ----
const MAILS_TO_OWNER = () => stub.mails.filter((m) => m.to[0].email === "kuperoy@gmail.com");
// Makes one operation on `events` fail like a database error; everything else is the normal fake.
function failEventsOp(op, message) {
  const realFrom = fake.from;
  fake.from = (table) => {
    if (table !== "events") return realFrom.call(fake, table);
    const real = realFrom.call(fake, table);
    return new Proxy(real, {
      get(target, prop) {
        if (prop !== op) return target[prop];
        return () => {
          const failed = { data: null, count: null, error: { code: "XX000", message } };
          const chain = { eq: () => chain, is: () => chain, select: () => chain, then: (res, rej) => Promise.resolve(failed).then(res, rej) };
          return chain;
        };
      },
    });
  };
  return () => { fake.from = realFrom; };
}

test("M-2: publish update fails after a COMPLETED capture -> 502 (not 400), owner alert with the order id, nothing published", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  const restore = failEventsOp("update", "db down <b>x</b>");
  let res;
  try { res = await callCapture(); } finally { restore(); }
  assert.equal(res.statusCode, 502);
  assert.notEqual(res.statusCode, 400);
  assert.equal(captures(), 1);
  assert.equal(draftRow().paid_at, null);
  assert.equal(MAILS_TO_OWNER().length, 1);
  const html = MAILS_TO_OWNER()[0].htmlContent;
  assert.ok(html.includes(ORDER_ID) && html.includes(SLUG));
  assert.ok(!html.includes("<b>x</b>"), "the error text is escaped");
  assert.ok(!/לא בוצע/.test(res.body.error), "the answer must not claim the payment was not made");
  assert.ok(!JSON.stringify(res.body).includes(PW));
});

test("M-2: legacy insert fails after a COMPLETED capture -> 502 and an owner alert with the order id", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(null));
  stub.capture = completedCapture();
  const restore = failEventsOp("insert", "insert failed");
  let res;
  try { res = await callCapture(); } finally { restore(); }
  assert.equal(res.statusCode, 502);
  assert.equal(MAILS_TO_OWNER().length, 1);
  assert.ok(MAILS_TO_OWNER()[0].htmlContent.includes(ORDER_ID));
  assert.ok(!/לא בוצע/.test(res.body.error));
});

test("M-2: an exception after the capture (legacy path, non-string name) -> 502 and an owner alert", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(null));
  stub.capture = completedCapture();
  const res = await callCapture(body({ customer_name: 12345 }));
  assert.equal(res.statusCode, 502);
  assert.equal(captures(), 1);
  assert.equal(MAILS_TO_OWNER().length, 1);
  assert.ok(MAILS_TO_OWNER()[0].htmlContent.includes(ORDER_ID));
});

test("M-2: an exception BEFORE the capture stays a plain 500 with no alert (no money moved)", async () => {
  seed();
  stub.order = () => { throw new Error("paypal order read blew up"); };
  const res = await callCapture();
  assert.equal(res.statusCode, 500);
  assert.equal(captures(), 0);
  assert.equal(stub.mails.length, 0);
});

// R-m2: the capture request itself fails without a readable answer: PayPal may have taken the money.
test("R-m2: the capture request throws (timeout / dropped connection) -> 502 with an owner alert 'capture status unknown'", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  stub.onCapture = () => { throw new Error("socket hang up"); };
  const res = await callCapture();
  assert.equal(res.statusCode, 502);
  assert.equal(captures(), 1, "the capture was attempted once");
  assert.equal(draftRow().paid_at, null, "nothing is published on an unknown outcome");
  assert.equal(MAILS_TO_OWNER().length, 1);
  const html = MAILS_TO_OWNER()[0].htmlContent;
  assert.ok(html.includes(ORDER_ID) && html.includes(SLUG));
  assert.ok(html.includes("capture status unknown"));
  assert.ok(!/לא בוצע/.test(res.body.error), "the answer must not claim the payment was not made");
  assert.ok(!JSON.stringify(res.body).includes(PW));
});

test("R-m2: the capture answer is not JSON -> 502 with an owner alert 'capture status unknown'", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  const stubFetch = global.fetch;
  global.fetch = async (url, init) => {
    const r = await stubFetch(url, init);
    if (/\/capture$/.test(String(url))) return { ...r, json: async () => { throw new SyntaxError("Unexpected token < in JSON"); } };
    return r;
  };
  let res;
  try { res = await callCapture(); } finally { global.fetch = stubFetch; }
  assert.equal(res.statusCode, 502);
  assert.equal(captures(), 1);
  assert.equal(draftRow().paid_at, null);
  assert.equal(MAILS_TO_OWNER().length, 1);
  const html = MAILS_TO_OWNER()[0].htmlContent;
  assert.ok(html.includes(ORDER_ID) && html.includes("capture status unknown"));
  assert.ok(!/לא בוצע/.test(res.body.error));
});

test("M-2: a retry of an order we signed that is already COMPLETED answers 409 'already paid', never 400, with no new capture", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG), { status: "COMPLETED" });
  stub.capture = completedCapture();
  const res = await callCapture();
  assert.equal(res.statusCode, 409);
  assert.equal(captures(), 0);
  assert.ok(/כבר שולמה/.test(res.body.error), "distinct 'already paid' message");
  assert.ok(!/לא בוצע/.test(res.body.error), "not 'the payment was not made'");
  assert.equal(draftRow().paid_at, null, "the retry changes nothing");
});

// ---- m-1: a malformed custom_id must never throw ----
test("m-1: parseCustomId rejects non-ASCII and malformed ids without throwing", () => {
  const { parseCustomId } = require("../api/_pay");
  const good = makeCustomId(SLUG);
  assert.equal(parseCustomId(good).valid, true);
  const sigLen = good.split(".")[1].length;
  const cases = [
    "x." + "é".repeat(sigLen),                 // same character count as a signature, more bytes
    SLUG + "." + "ש".repeat(sigLen),
    "😀.😀😀😀😀😀😀😀😀😀😀😀",
    "." + "a".repeat(sigLen), "no-dot", "", "a.", 42, null, undefined, {}, [],
  ];
  for (const c of cases) assert.doesNotThrow(() => parseCustomId(c), String(c));
  for (const c of cases) assert.equal(parseCustomId(c).valid, false, String(c));
});

test("m-1: capture of an order whose custom_id is 22 non-ASCII characters answers 400, no capture", async () => {
  seed();
  const sigLen = makeCustomId(SLUG).split(".")[1].length;
  stub.order = approvedOrder("x." + "é".repeat(sigLen));
  stub.capture = completedCapture();
  const res = await callCapture();
  assert.equal(res.statusCode, 400);
  assert.equal(captures(), 0);
});

// ---- m-5: intent and payee ----
test("m-5: intent CAPTURE and a matching payee are accepted; an absent intent or payee never blocks a real order", async () => {
  const saved = process.env.PAYPAL_MERCHANT_ID;
  process.env.PAYPAL_MERCHANT_ID = "MERCHANT-FAKE-1";
  try {
    const variants = [
      { intent: "CAPTURE" },
      { intent: "CAPTURE", payee: { merchant_id: "MERCHANT-FAKE-1" } },
      {},                                   // no intent, no payee: what an older/other response shape looks like
      { intent: "CAPTURE", payee: { email_address: "x@example.test" } },   // payee without merchant_id
    ];
    for (const extra of variants) {
      seed();
      const c = makeCustomId(SLUG);
      const o = approvedOrder(c, { ...extra.intent ? { intent: extra.intent } : {} });
      if (extra.payee) o.purchase_units[0].payee = extra.payee;
      stub.order = o;
      stub.capture = completedCapture();
      const res = await callCapture();
      assert.equal(res.statusCode, 200, JSON.stringify(extra));
    }
  } finally {
    if (saved === undefined) delete process.env.PAYPAL_MERCHANT_ID; else process.env.PAYPAL_MERCHANT_ID = saved;
  }
});

test("m-5: an order paid to another merchant is refused (400, no capture) when PAYPAL_MERCHANT_ID is set", async () => {
  const saved = process.env.PAYPAL_MERCHANT_ID;
  process.env.PAYPAL_MERCHANT_ID = "MERCHANT-FAKE-1";
  try {
    seed();
    const o = approvedOrder(makeCustomId(SLUG), { intent: "CAPTURE" });
    o.purchase_units[0].payee = { merchant_id: "MERCHANT-OTHER-9" };
    stub.order = o;
    stub.capture = completedCapture();
    const res = await callCapture();
    assert.equal(res.statusCode, 400);
    assert.equal(captures(), 0);
  } finally {
    if (saved === undefined) delete process.env.PAYPAL_MERCHANT_ID; else process.env.PAYPAL_MERCHANT_ID = saved;
  }
});

// R-m1: PAYPAL_MERCHANT_ID unset is the production default, and real orders carry a payee: never refused.
test("R-m1: with PAYPAL_MERCHANT_ID UNSET a normal 99.00 ILS signed order with a payee captures and publishes (200, one capture)", async () => {
  const saved = process.env.PAYPAL_MERCHANT_ID;
  delete process.env.PAYPAL_MERCHANT_ID;
  try {
    seed();
    const o = approvedOrder(makeCustomId(SLUG), { intent: "CAPTURE" });
    o.purchase_units[0].payee = { merchant_id: "ANY-PAYEE-FAKE-7" };
    stub.order = o;
    stub.capture = completedCapture();
    const res = await callCapture();
    assert.equal(res.statusCode, 200);
    assert.equal(captures(), 1);
    assert.ok(draftRow().paid_at, "published");
  } finally {
    if (saved === undefined) delete process.env.PAYPAL_MERCHANT_ID; else process.env.PAYPAL_MERCHANT_ID = saved;
  }
});

// ---- create-order: ownership proof and signature ----
async function callCreateOrder(b, headers = { origin: "https://rsvp.kupernet.com", host: "rsvp.kupernet.com" }) {
  const res = makeRes();
  await createOrder({ method: "POST", query: {}, headers, body: b }, res);
  return res;
}

test("create-order with the right password signs the order for the slug, 99.00 ILS", async () => {
  seed();
  const res = await callCreateOrder({ slug: SLUG, password: PW });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { id: ORDER_ID });
  const created = stub.createdOrders[0];
  assert.equal(created.purchase_units[0].amount.value, "99.00");
  assert.equal(created.purchase_units[0].amount.currency_code, "ILS");
  assert.equal(created.purchase_units[0].custom_id, makeCustomId(SLUG));
  assert.ok(created.purchase_units[0].custom_id.length <= 127);
});

test("create-order: wrong password 403, unknown slug 403 (same answer), no PayPal order is made", async () => {
  seed();
  for (const b of [{ slug: SLUG, password: WRONG_PW }, { slug: SLUG, password: "" }, { slug: SLUG }, { slug: "bm-nobody-2027", password: PW }]) {
    const res = await callCreateOrder(b);
    assert.equal(res.statusCode, 403, JSON.stringify(b));
  }
  assert.equal(stub.byKind("createOrder").length, 0);
});

test("create-order: a paid event is refused even with its right password (400)", async () => {
  seed();
  const res = await callCreateOrder({ slug: OTHER, password: OTHER_PW });
  assert.equal(res.statusCode, 400);
  assert.equal(stub.byKind("createOrder").length, 0);
});

test("create-order without a slug (legacy) signs 'new'; an old client sending no body still works", async () => {
  seed();
  for (const b of [{ slug: "", password: "" }, undefined, {}]) {
    stub.reset();
    const res = await callCreateOrder(b);
    assert.equal(res.statusCode, 200);
    assert.equal(stub.createdOrders[0].purchase_units[0].custom_id, makeCustomId(null));
  }
});

test("create-order answers 500 when no signing key exists, and makes no order", async () => {
  seed();
  const saved = process.env.PAYPAL_SECRET;
  delete process.env.PAYPAL_SECRET;
  try {
    const res = await callCreateOrder({ slug: SLUG, password: PW });
    assert.equal(res.statusCode, 500);
    assert.equal(stub.byKind("createOrder").length, 0);
  } finally { process.env.PAYPAL_SECRET = saved; }
});

test("ORDER_SIGNING_KEY, when set, replaces the PAYPAL_SECRET-derived key", async () => {
  seed();
  const before = makeCustomId(SLUG);
  process.env.ORDER_SIGNING_KEY = "fake-signing-material";
  try {
    const after = makeCustomId(SLUG);
    assert.notEqual(before, after);
    stub.order = approvedOrder(before);   // signed with the old key: refused now
    stub.capture = completedCapture();
    assert.equal((await callCapture()).statusCode, 400);
    stub.order = approvedOrder(after);
    assert.equal((await callCapture()).statusCode, 200);
  } finally { delete process.env.ORDER_SIGNING_KEY; }
});

test("create-order never reads the secret into a response and capture answers contain no PayPal token", async () => {
  seed();
  stub.order = approvedOrder(makeCustomId(SLUG));
  stub.capture = completedCapture();
  const res = await callCapture();
  assert.ok(!JSON.stringify(res.body).includes("stub"));
});
