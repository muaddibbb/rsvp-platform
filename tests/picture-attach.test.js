"use strict";
// Picture P2: create-event stores picture_path on the draft, paypal-capture attaches it (download + upload to the
// PUBLIC bucket under a new name, staging removed), the guest API exposes picture_url, rsvp.html renders it.
// Written test-first from the acceptance criteria and the Interface contract (api/_picture.js), offline:
// Supabase (in-memory fake plus a storage stub built here), PayPal and Brevo are stubbed.
process.env.SUPABASE_URL = "https://fake-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key-SECRET-123";
process.env.PAYPAL_CLIENT_ID = "fake-client-id";
process.env.PAYPAL_SECRET = "fake-paypal-secret-value";
process.env.PAYPAL_SANDBOX = "true";
process.env.BREVO_API_KEY = "fake-brevo-key-value";
delete process.env.ORDER_SIGNING_KEY;

const test = require("node:test");
require("./_quiet")(test);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createFakeSupabase, install, makeRes } = require("./_fake-supabase");
const { installFetchStub, approvedOrder, completedCapture, makeCustomId } = require("./_paypal-stub");

const ROOT = path.resolve(__dirname, "..");
const stub = installFetchStub();

const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "223e4567-e89b-42d3-a456-426614174111";
const STG_A = `ok/${UUID_A}.jpg`;
const STG_B = `ok/${UUID_B}.jpg`;
const MAX = 1572864;
const jpeg = (n = 1000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 1)]);

// ---- storage stub: two buckets, call log, switches ----
let st;
function freshStorage() {
  st = {
    calls: [],
    buckets: { "picture-staging": new Map(), "event-pictures": new Map() },
    downloadError: null, uploadError: null, removeError: null, removeThrows: false, failUpdate: false, pgrst204: false, hang: false, release: null,
  };
}
freshStorage();
const storage = {
  from(bucket) {
    const rec = (op, args) => st.calls.push({ bucket, op, args });
    const objs = () => st.buckets[bucket];
    return {
      async download(p) {
        rec("download", [p]);
        if (bucket === "picture-staging" && st.hang) await new Promise((r) => { st.release = r; });
        if (bucket === "picture-staging" && st.downloadError) return { data: null, error: st.downloadError };
        if (!objs().has(p)) return { data: null, error: { message: "Object not found", status: 404 } };
        return { data: new Blob([objs().get(p)]), error: null };
      },
      async upload(p, buf, opts) {
        rec("upload", [p, buf, opts]);
        if (st.uploadError) return { data: null, error: st.uploadError };
        if (objs().has(p) && !(opts && opts.upsert)) return { data: null, error: { message: "exists" } };
        objs().set(p, Buffer.from(buf));
        return { data: { path: p }, error: null };
      },
      async remove(paths) {
        rec("remove", [paths]);
        if (bucket === "picture-staging" && st.removeThrows) throw new Error("remove boom");
        if (bucket === "picture-staging" && st.removeError) return { data: null, error: st.removeError };
        for (const p of paths) objs().delete(p);
        return { data: paths.map((name) => ({ name })), error: null };
      },
    };
  },
};
const ops = (bucket, op) => st.calls.filter((c) => c.bucket === bucket && c.op === op);

// ---- supabase proxy: handlers grab their client once, the proxy follows `fake` ----
let fake;
const failing = (code = "XX000", message = "boom") => {
  const p = new Proxy({}, { get: (_, k) => (k === "then" ? (res) => res({ data: null, count: null, error: { code, message } }) : () => p) });
  return p;
};
const PGRST = "Could not find the 'picture_path' column of 'events' in the schema cache";
function fresh(seed, opts) { fake = createFakeSupabase(seed, opts); stub.reset(); freshStorage(); return fake; }
fresh();
install({
  storage: { from: (b) => storage.from(b) },
  rpc: (n, a) => fake.rpc(n, a),
  from: (t) => {
    const b = fake.from(t);
    if (t === "events" && st.failUpdate) {
      const orig = b.update.bind(b);
      b.update = (payload) => (payload && payload.paid_at ? failing() : orig(payload));
    }
    if (t === "events" && st.pgrst204) {
      const oi = b.insert.bind(b), ou = b.update.bind(b);
      b.insert = (payload) => (payload && "picture_path" in payload ? failing("PGRST204", PGRST) : oi(payload));
      b.update = (payload) => (payload && "picture_path" in payload ? failing("PGRST204", PGRST) : ou(payload));
    }
    return b;
  },
});
const createEvent = require("../api/create-event");
const capture = require("../api/paypal-capture");
const eventApi = require("../api/event/[slug]");
const pic = () => require("../api/_picture");

const FUTURE = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
const SITE = { origin: "https://rsvp.kupernet.com", host: "rsvp.kupernet.com" };
const H = (ip = "203.0.113.7") => ({ ...SITE, "x-forwarded-for": ip });
const SLUG = "bm-cohen-2027";
const ORDER_ID = "ORDER-FAKE-0001";
const PW = "draft-fake-1";
const BAD_SHAPE_MSG = "נתיב תמונה לא תקין";
const MISSING_MSG = "התמונה לא נמצאה, יש להעלות אותה מחדש";

const goodEvent = (over = {}) => ({
  event_type: "bar_mitzvah", event_name: "Party", gregorian_date: FUTURE, event_time: "19:00",
  location: "Hall", address: "1 Fake St", customer_name: "Dana Cohen", customer_email: "dana@example.test", ...over,
});
async function callCreate(b) {
  const res = makeRes();
  await createEvent({ method: "POST", query: {}, headers: H(), body: b }, res);
  return res;
}
const stage = (p = STG_A, buf = jpeg()) => st.buckets["picture-staging"].set(p, buf);
const publicObjs = () => [...st.buckets["event-pictures"].keys()];
const client = () => ({ storage: { from: (b) => storage.from(b) } });

// ============ helper unit tests: api/_picture.js ============
test("_picture exports the contract constants", () => {
  const p = pic();
  assert.equal(p.STAGING_BUCKET, "picture-staging");
  assert.equal(p.PUBLIC_BUCKET, "event-pictures");
  assert.ok(p.STAGING_RE instanceof RegExp);
});
test("isStagingPath accepts only ok/<36 hex-dash>.jpg strings", () => {
  const { isStagingPath } = pic();
  assert.equal(isStagingPath(STG_A), true);
  for (const bad of [
    `raw/${UUID_A}.jpg`, `pic/${UUID_A}.jpg`, `ok/../${UUID_A}.jpg`, `ok/${UUID_A}.jpg\n`, `\nok/${UUID_A}.jpg`,
    `ok/${UUID_A.toUpperCase()}.jpg`, `ok/${UUID_A}.png`, `ok/${UUID_A}.jpg/x`, `ok/../../etc/passwd`,
    `ok/${"a".repeat(35)}.jpg`, `ok/${"a".repeat(37)}.jpg`, "", null, undefined, 42, {}, [STG_A], ["x"],
  ]) assert.equal(isStagingPath(bad), false, "must reject " + JSON.stringify(bad));
});
test("publicUrl builds the public bucket URL from SUPABASE_URL", () => {
  assert.equal(pic().publicUrl(`pic/${UUID_A}.jpg`), `https://fake-project.supabase.co/storage/v1/object/public/event-pictures/pic/${UUID_A}.jpg`);
});
test("stagingExists: true when the object downloads; false on missing, error and throw", async () => {
  fresh(); stage();
  const { stagingExists } = pic();
  assert.equal(await stagingExists(client(), STG_A), true);
  assert.equal(await stagingExists(client(), STG_B), false);
  assert.equal(await stagingExists({ storage: { from: () => ({ download: async () => { throw new Error("x"); } }) } }, STG_A), false);
  assert.equal(await stagingExists({ storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) } }, STG_A), false);
});
test("attachPicture happy path: new pic/ name, image/jpeg, upsert false, staging removed", async () => {
  fresh(); stage();
  const r = await pic().attachPicture(client(), STG_A);
  assert.equal(r.ok, true);
  assert.match(r.path, /^pic\/[0-9a-f-]{36}\.jpg$/);
  assert.ok(!r.path.includes(UUID_A));
  const up = ops("event-pictures", "upload");
  assert.equal(up.length, 1);
  assert.equal(up[0].args[0], r.path);
  assert.deepEqual(up[0].args[2], { contentType: "image/jpeg", upsert: false });
  assert.deepEqual(ops("picture-staging", "remove")[0].args[0], [STG_A]);
  assert.equal(st.buckets["picture-staging"].has(STG_A), false);
  assert.ok(st.buckets["event-pictures"].has(r.path));
});
test("attachPicture never throws: download error, missing, bad bytes, empty, oversize, upload error, storage throw", async () => {
  const { attachPicture } = pic();
  const cases = {
    "download error": () => { stage(); st.downloadError = { message: "dl" }; },
    "missing object": () => {},
    "png bytes": () => stage(STG_A, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)])),
    "empty": () => stage(STG_A, Buffer.alloc(0)),
    "oversize": () => stage(STG_A, jpeg(MAX + 1)),
    "upload error": () => { stage(); st.uploadError = { message: "up" }; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    fresh(); setup();
    const r = await attachPicture(client(), STG_A);
    assert.equal(r.ok, false, name);
    assert.equal(typeof r.reason, "string", name);
    assert.deepEqual(publicObjs(), [], name + ": nothing public");
  }
  const r = await attachPicture({ storage: { from: () => { throw new Error("storage down"); } } }, STG_A);
  assert.equal(r.ok, false);
});
test("attachPicture accepts exactly the maximum size", async () => {
  fresh(); stage(STG_A, jpeg(MAX));
  assert.equal((await pic().attachPicture(client(), STG_A)).ok, true);
});
test("attachPicture: a failing staging remove keeps the public copy and still answers ok (Leto decision)", async () => {
  for (const mode of ["error", "throw"]) {
    fresh(); stage();
    if (mode === "error") st.removeError = { message: "rm fail" }; else st.removeThrows = true;
    const r = await pic().attachPicture(client(), STG_A);
    assert.equal(r.ok, true, mode);
    assert.ok(st.buckets["event-pictures"].has(r.path), mode);
    assert.equal(ops("event-pictures", "remove").length, 0, "no removePublic");
  }
});
test("removePublic removes from the public bucket and never throws", async () => {
  fresh(); st.buckets["event-pictures"].set(`pic/${UUID_A}.jpg`, jpeg());
  await pic().removePublic(client(), `pic/${UUID_A}.jpg`);
  assert.deepEqual(ops("event-pictures", "remove")[0].args[0], [`pic/${UUID_A}.jpg`]);
  await pic().removePublic({ storage: { from: () => { throw new Error("x"); } } }, "pic/x.jpg");
});

// ============ create-event ============
test("create-event: no picture_path leaves the row without the key and makes no storage call", async () => {
  fresh();
  const res = await callCreate(goodEvent());
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(!("picture_path" in fake.store.events[0]), "row identical to today");
  assert.equal(st.calls.length, 0);
});
test("create-event: null and empty picture_path count as absent", async () => {
  for (const v of [null, ""]) {
    fresh();
    const res = await callCreate(goodEvent({ picture_path: v }));
    assert.equal(res.statusCode, 200);
    assert.ok(!("picture_path" in fake.store.events[0]));
  }
});
test("create-event: bad shape is 400 with the exact message, nothing inserted", async () => {
  for (const v of [`raw/${UUID_A}.jpg`, "ok/x.jpg", `ok/../${UUID_A}.jpg`, 5, {}, ["a"], true, `ok/${UUID_A}.jpg\n`]) {
    fresh(); stage();
    const res = await callCreate(goodEvent({ picture_path: v }));
    assert.equal(res.statusCode, 400, JSON.stringify(v));
    assert.deepEqual(res.body, { error: BAD_SHAPE_MSG });
    assert.equal(fake.store.events.length, 0);
  }
});
test("create-event: well-formed path whose object is missing is 400 with the exact message", async () => {
  fresh();
  const res = await callCreate(goodEvent({ picture_path: STG_A }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: MISSING_MSG });
  assert.equal(fake.store.events.length, 0);
  assert.equal(ops("picture-staging", "download").length, 1, "existence checked in picture-staging");
});
test("create-event: a valid picture_path is stored on the draft row (staging path), draft stays unpaid", async () => {
  fresh(); stage();
  const res = await callCreate(goodEvent({ picture_path: STG_A }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const row = fake.store.events.find((e) => e.slug === res.body.slug);
  assert.equal(row.picture_path, STG_A);
  assert.equal(row.paid_at, null);
  assert.equal(ops("event-pictures", "upload").length, 0, "nothing public at create time");
});
test("create-event: the column missing (42703) still creates the event, without the picture", async () => {
  fresh({}, { missingColumns: { events: ["picture_path"] } }); stage();
  const res = await callCreate(goodEvent({ picture_path: STG_A }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fake.store.events.length, 1);
  assert.ok(!("picture_path" in fake.store.events[0]));
});

// ============ capture ============
const body = (extra = {}) => ({ orderID: ORDER_ID, checkoutId: "chk-12345678", slug: SLUG, customer_name: "Dana Cohen", customer_email: "dana@example.test", event_type: "bar_mitzvah", event_name: "Draft Event", gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "1 Fake St", ...extra });
function seedDraft(extra = {}, opts) {
  fresh({
    events: [{ id: 1, slug: SLUG, customer_name: "Dana Cohen", customer_email: "dana@example.test", event_type: "bar_mitzvah", event_name: "Draft Event", gregorian_date: FUTURE, event_time: "19:00", location: "Hall", address: "1 Fake St", dashboard_password: PW, paid_at: null, active: true, ...extra }],
  }, opts);
}
async function callCapture(b = body(), signed = SLUG) {
  stub.order = approvedOrder(makeCustomId(signed));
  stub.capture = completedCapture();
  const res = makeRes();
  await capture({ method: "POST", query: {}, headers: SITE, body: b }, res);
  return res;
}
const draftRow = () => fake.store.events.find((e) => e.slug === SLUG);
const alertMails = () => stub.mails.filter((m) => /תמונה לא צורפה/.test(m.subject));
const adminMail = () => stub.mails.find((m) => String(m.subject).startsWith("💰"));
const nothingAttached = () => assert.ok(!String(draftRow().picture_path || "").startsWith("pic/"));

test("capture: copies to the public bucket under a NEW pic/ name, removes staging, publishes with the pic/ path", async () => {
  seedDraft({ picture_path: STG_A }); stage();
  const res = await callCapture();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ["event_name", "slug"]);
  const row = draftRow();
  assert.ok(row.paid_at);
  assert.match(row.picture_path, /^pic\/[0-9a-f-]{36}\.jpg$/);
  assert.ok(!row.picture_path.includes(UUID_A), "never the staging name");
  const up = ops("event-pictures", "upload");
  assert.equal(up.length, 1);
  assert.equal(up[0].args[0], row.picture_path);
  assert.deepEqual(up[0].args[2], { contentType: "image/jpeg", upsert: false });
  assert.equal(st.buckets["picture-staging"].has(STG_A), false, "staging removed");
  assert.deepEqual(publicObjs(), [row.picture_path]);
  assert.equal(alertMails().length, 0);
});
test("capture: the DRAFT picture_path is preferred over the body's when both exist", async () => {
  seedDraft({ picture_path: STG_A }); stage(STG_A); stage(STG_B);
  const res = await callCapture(body({ picture_path: STG_B }));
  assert.equal(res.statusCode, 200);
  assert.ok(draftRow().picture_path.startsWith("pic/"));
  assert.ok(ops("picture-staging", "download").some((c) => c.args[0] === STG_A));
  assert.ok(!ops("picture-staging", "download").some((c) => c.args[0] === STG_B), "body path unused");
  assert.equal(st.buckets["picture-staging"].has(STG_A), false);
  assert.equal(st.buckets["picture-staging"].has(STG_B), true);
});
test("capture: the body picture_path is used when the draft has none or an invalid one", async () => {
  for (const draftPath of [undefined, null, "", "ok/../x.jpg"]) {
    seedDraft(draftPath === undefined ? {} : { picture_path: draftPath }); stage(STG_B);
    const res = await callCapture(body({ picture_path: STG_B }));
    assert.equal(res.statusCode, 200);
    assert.ok(String(draftRow().picture_path).startsWith("pic/"), "draft " + JSON.stringify(draftPath));
    assert.ok(ops("picture-staging", "download").every((c) => c.args[0] === STG_B));
  }
});
test("capture: a malformed body picture_path is ignored, the draft's is used", async () => {
  seedDraft({ picture_path: STG_A }); stage();
  const res = await callCapture(body({ picture_path: "ok/../../x.jpg" }));
  assert.equal(res.statusCode, 200);
  assert.ok(draftRow().picture_path.startsWith("pic/"));
  assert.ok(ops("picture-staging", "download").every((c) => c.args[0] === STG_A));
});
test("capture: a client cannot set picture_path to an arbitrary public path through the body", async () => {
  seedDraft({});
  const res = await callCapture(body({ picture_path: "pic/evil.jpg" }));
  assert.equal(res.statusCode, 200);
  assert.ok(!draftRow().picture_path);
  assert.equal(st.calls.length, 0);
});
test("capture: no picture anywhere means no storage call and no alert", async () => {
  seedDraft({});
  const res = await callCapture();
  assert.equal(res.statusCode, 200);
  assert.equal(st.calls.length, 0);
  assert.ok(!draftRow().picture_path);
  assert.equal(alertMails().length, 0);
});

const FAILS = {
  "download fails": () => { stage(); st.downloadError = { message: "dl" }; },
  "object missing": () => {},
  "upload fails": () => { stage(); st.uploadError = { message: "up" }; },
  "bad bytes (not FFD8FF)": () => stage(STG_A, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(600)])),
  "oversize": () => stage(STG_A, jpeg(MAX + 1)),
};
for (const [name, setup] of Object.entries(FAILS)) {
  test(`capture: ${name} -> sale published without picture, owner alerted, 200`, async () => {
    seedDraft({ picture_path: STG_A }); setup();
    const res = await callCapture();
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body).sort(), ["event_name", "slug"]);
    assert.ok(draftRow().paid_at, "published");
    nothingAttached();
    assert.deepEqual(publicObjs(), [], "nothing public");
    assert.equal(alertMails().length, 1, "one owner alert");
    assert.match(alertMails()[0].htmlContent, new RegExp(SLUG));
    assert.ok(adminMail(), "new-order mail still sent");
    assert.ok(stub.mails.some((m) => m.htmlContent.includes(PW)), "buyer mail still sent");
    assert.ok(!/event-pictures/.test(adminMail().htmlContent), "no picture line");
  });
}
test("capture: storage throwing outright still publishes", async () => {
  seedDraft({ picture_path: STG_A });
  const orig = storage.from;
  storage.from = () => { throw new Error("storage down"); };
  try {
    const res = await callCapture();
    assert.equal(res.statusCode, 200);
    assert.ok(draftRow().paid_at);
    assert.equal(alertMails().length, 1);
  } finally { storage.from = orig; }
});
test("capture: column picture_path missing -> published without picture, public copy removed, owner alerted", async () => {
  seedDraft({}, { missingColumns: { events: ["picture_path"] } });
  stage();
  const res = await callCapture(body({ picture_path: STG_A }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(draftRow().paid_at, "published");
  assert.ok(!("picture_path" in draftRow()));
  assert.deepEqual(publicObjs(), [], "public copy removed");
  assert.equal(alertMails().length, 1);
});
test("capture: staging remove failure keeps the picture attached, no removePublic, error logged", async () => {
  seedDraft({ picture_path: STG_A }); stage(); st.removeError = { message: "rm fail" };
  const logged = [];
  const saved = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  let res;
  try { res = await callCapture(); } finally { console.error = saved; }
  assert.equal(res.statusCode, 200);
  assert.match(draftRow().picture_path, /^pic\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(publicObjs().length, 1, "public copy stays");
  assert.equal(ops("event-pictures", "remove").length, 0, "no removePublic");
  assert.equal(st.buckets["picture-staging"].has(STG_A), true, "leftover staging file");
  assert.ok(logged.some((l) => l.includes("picture staging remove failed")), "logged: " + JSON.stringify(logged));
  assert.ok(adminMail().htmlContent.includes(draftRow().picture_path), "admin mail shows the picture");
});
test("capture: publish update failing after a copy removes the public copy", async () => {
  seedDraft({ picture_path: STG_A }); stage(); st.failUpdate = true;
  await callCapture();
  assert.deepEqual(publicObjs(), [], "public copy removed (best effort)");
  assert.ok(ops("event-pictures", "remove").length >= 1);
});
test("capture: legacy create-on-capture ignores pictures", async () => {
  seedDraft({}); stage();
  const res = await callCapture(body({ picture_path: STG_A }), null);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const created = fake.store.events.find((e) => e.slug === res.body.slug);
  assert.ok(created && created.paid_at);
  assert.ok(!created.picture_path);
  assert.equal(st.calls.length, 0, "no storage call");
});
test("capture: owner new-order mail carries the public URL when attached, nothing extra otherwise", async () => {
  seedDraft({ picture_path: STG_A }); stage();
  await callCapture();
  const url = pic().publicUrl(draftRow().picture_path);
  const withPic = adminMail().htmlContent;
  assert.ok(withPic.includes(`href="${url}"`), "public URL in owner mail");
  seedDraft({});
  await callCapture();
  const plain = adminMail().htmlContent;
  assert.ok(!plain.includes("event-pictures") && !plain.includes("תמונה:"));
  const strip = (s) => s.replace(/<br\/><strong>תמונה:<\/strong>[^]*?<\/a>/, "");
  assert.equal(strip(plain), strip(withPic), "otherwise identical");
});

// ---- delta: PGRST204, timeout, limiter order, alert text ----
test("create-event: PGRST204 (schema cache lacks the column) still creates the event, retried without it", async () => {
  fresh(); stage(); st.pgrst204 = true;
  const res = await callCreate(goodEvent({ picture_path: STG_A }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(fake.store.events.length, 1);
  assert.ok(!("picture_path" in fake.store.events[0]));
});
test("capture: PGRST204 on the publish update -> published without picture, 200 not 502, public copy removed, owner alerted", async () => {
  seedDraft({ picture_path: STG_A }); stage(); st.pgrst204 = true;
  const res = await callCapture();
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(draftRow().paid_at, "published");
  assert.ok(!String(draftRow().picture_path || "").startsWith("pic/"));
  assert.deepEqual(publicObjs(), []);
  assert.equal(alertMails().length, 1);
});
test("capture: a hung attach hits the deadline -> published without picture, alert mentions timeout and slug, no throw", async () => {
  process.env.PICTURE_ATTACH_TIMEOUT_MS = "50";
  try {
    seedDraft({ picture_path: STG_A }); stage(); st.hang = true;
    const res = await callCapture();
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(draftRow().paid_at, "published");
    nothingAttached();
    assert.equal(alertMails().length, 1);
    assert.match(alertMails()[0].htmlContent, /timeout/);
    assert.match(alertMails()[0].htmlContent, new RegExp(SLUG));
    assert.ok(adminMail(), "new-order mail still sent");
    if (st.release) st.release();
    await new Promise((r) => setTimeout(r, 30));
  } finally { delete process.env.PICTURE_ATTACH_TIMEOUT_MS; }
});
test("capture: a late successful attach after the timeout removes the late public object", async () => {
  process.env.PICTURE_ATTACH_TIMEOUT_MS = "50";
  try {
    seedDraft({ picture_path: STG_A }); stage(); st.hang = true;
    const res = await callCapture();
    assert.equal(res.statusCode, 200);
    nothingAttached();
    assert.deepEqual(publicObjs(), []);
    st.hang = false; st.release();           // the slow download now completes and the upload follows
    await new Promise((r) => setTimeout(r, 50));
    const up = ops("event-pictures", "upload");
    assert.equal(up.length, 1, "the late attach did upload");
    const rm = ops("event-pictures", "remove");
    assert.ok(rm.some((c) => c.args[0].includes(up[0].args[0])), "late object removed");
    assert.deepEqual(publicObjs(), []);
    nothingAttached();
  } finally { delete process.env.PICTURE_ATTACH_TIMEOUT_MS; }
});
test("_picture: attachTimeoutMs reads the env at call time, default 6000 and ATTACH_TIMEOUT_MS exported", () => {
  const p = pic();
  assert.equal(p.ATTACH_TIMEOUT_MS, 6000);
  delete process.env.PICTURE_ATTACH_TIMEOUT_MS;
  assert.equal(p.attachTimeoutMs(), 6000);
  process.env.PICTURE_ATTACH_TIMEOUT_MS = "123";
  try { assert.equal(p.attachTimeoutMs(), 123); } finally { delete process.env.PICTURE_ATTACH_TIMEOUT_MS; }
  process.env.PICTURE_ATTACH_TIMEOUT_MS = "junk";
  try { assert.equal(p.attachTimeoutMs(), 6000); } finally { delete process.env.PICTURE_ATTACH_TIMEOUT_MS; }
});
test("create-event: an over-limit call (429) never touches picture-staging", async () => {
  fresh(); stage();
  for (let i = 0; i < 3; i++) assert.equal((await callCreate(goodEvent())).statusCode, 200);
  const res = await callCreate(goodEvent({ picture_path: STG_A }));
  assert.equal(res.statusCode, 429);
  assert.equal(ops("picture-staging", "download").length, 0, "stagingExists not called before the limiter passes");
  assert.equal(fake.store.events.length, 3);
});
test("capture: publish update failing after a copy -> 502 and the owner alert says the staged picture may be gone", async () => {
  seedDraft({ picture_path: STG_A }); stage(); st.failUpdate = true;
  const res = await callCapture();
  assert.equal(res.statusCode, 502);
  assert.ok(stub.mails.some((m) => /may be gone/.test(m.htmlContent) && /re-upload/.test(m.htmlContent)), "alert text");
});
test("capture: publish update failing with no picture has no 'may be gone' text", async () => {
  seedDraft({}); st.failUpdate = true;
  await callCapture();
  assert.ok(!stub.mails.some((m) => /may be gone/.test(m.htmlContent)));
});

// ============ guest API ============
async function getEvent(slug) {
  const res = makeRes();
  await eventApi({ method: "GET", query: { slug }, headers: {} }, res);
  return res;
}
const PIC = `pic/${UUID_A}.jpg`;
const ev = (over) => ({ id: 1, slug: "e1", event_type: "wedding", event_name: "E", hebrew_date: null, gregorian_date: FUTURE, event_time: "19:00", location: "L", address: "A", extra_note: null, paid_at: "2026-09-01T10:00:00.000Z", active: true, ...over });
test("guest API: paid + active + pic/ path returns picture_url and never picture_path", async () => {
  fresh({ events: [ev({ picture_path: PIC })] });
  const res = await getEvent("e1");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.picture_url, `https://fake-project.supabase.co/storage/v1/object/public/event-pictures/${PIC}`);
  assert.ok(!("picture_path" in res.body));
});
test("guest API: no picture, closed event, non-pic/ path and empty path give no picture_url key", async () => {
  const cases = {
    "none": ev({}), "null path": ev({ picture_path: null }), "empty": ev({ picture_path: "" }),
    "closed": ev({ picture_path: PIC, active: false }),
    "staging path": ev({ picture_path: STG_A }), "raw path": ev({ picture_path: `raw/${UUID_A}.jpg` }),
    "nested pic": ev({ picture_path: `x/pic/${UUID_A}.jpg` }),
  };
  for (const [name, row] of Object.entries(cases)) {
    fresh({ events: [row] });
    const res = await getEvent("e1");
    if (name === "closed") { assert.equal(res.statusCode, 404, name); continue; }
    assert.equal(res.statusCode, 200, name);
    assert.ok(!("picture_url" in res.body), name);
    assert.ok(!("picture_path" in res.body), name);
  }
});
test("guest API: an unpaid draft is 404 and exposes no picture anywhere", async () => {
  fresh({ events: [ev({ paid_at: null, picture_path: PIC })] });
  const res = await getEvent("e1");
  assert.equal(res.statusCode, 404);
  assert.ok(!JSON.stringify(res.body).includes("pic/"));
});
test("guest API: column missing (42703) still serves the event without picture_url", async () => {
  fresh({ events: [ev({})] }, { missingColumns: { events: ["picture_path"] } });
  const res = await getEvent("e1");
  assert.equal(res.statusCode, 200);
  assert.ok(!("picture_url" in res.body));
});

// ============ rsvp.html (criterion 7): populateEvent run in a vm with a tiny DOM ============
const HTML = fs.readFileSync(path.join(ROOT, "public", "rsvp.html"), "utf8");
function extractPopulateEvent() {
  const start = HTML.indexOf("function populateEvent");
  assert.ok(start > 0, "populateEvent exists");
  let i = HTML.indexOf("{", start), depth = 0;
  for (; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    if (HTML[i] === "}" && --depth === 0) break;
  }
  return HTML.slice(start, i + 1);
}
function runPopulate(evObj) {
  const els = new Map();
  const mk = (id) => ({
    id, style: {}, textContent: "", href: "", removed: false,
    insertAdjacentElement(pos, el) { this.inserted = { pos, el }; return el; },
  });
  const doc = {
    title: "",
    getElementById: (id) => { if (id === "eventPicture") return null; if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
    createElement: (tag) => { const e = mk(""); e.tag = tag; e.remove = () => { e.removed = true; }; return e; },
  };
  const ctx = vm.createContext({ document: doc, t: (k) => k, EVENT_EMOJI: {}, formatEventDate: () => "d", slug: "s", window: {} });
  vm.runInContext(extractPopulateEvent() + "; globalThis.__pe = populateEvent;", ctx);
  ctx.__pe({ event_name: "N", event_type: "wedding", event_time: "19:00", location: "L", address: "A", ...evObj });
  return { els };
}
test("rsvp.html: a picture_url is rendered as a DOM <img> right after the emoji (src and alt only, onerror removes it)", () => {
  const url = "https://fake-project.supabase.co/storage/v1/object/public/event-pictures/pic/x.jpg";
  const { els } = runPopulate({ picture_url: url });
  const emoji = els.get("eventEmoji");
  assert.ok(emoji.inserted, "inserted next to #eventEmoji");
  assert.equal(emoji.inserted.pos, "afterend");
  const img = emoji.inserted.el;
  assert.equal(img.tag, "img");
  assert.equal(img.id, "eventPicture");
  assert.equal(img.alt, "");
  assert.equal(img.src, url);
  assert.equal(img.style.maxWidth, "100%");
  assert.equal(typeof img.onerror, "function");
  img.onerror();
  assert.equal(img.removed, true, "a failing image hides itself");
});
test("rsvp.html: no picture_url, or a non-https one, renders nothing", () => {
  for (const v of [undefined, null, "", "http://x/y.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", 42, {}]) {
    const { els } = runPopulate(v === undefined ? {} : { picture_url: v });
    assert.ok(!els.get("eventEmoji").inserted, "nothing for " + JSON.stringify(v));
  }
});
test("rsvp.html: the picture code never goes through innerHTML or insertAdjacentHTML", () => {
  const src = extractPopulateEvent();
  assert.ok(/createElement\(\s*["']img["']\s*\)/.test(src));
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(src));
  assert.ok(/onerror/.test(src));
});

// ============ budget and pins ============
test("function count stays 10 (underscore files are not functions) and _picture.js exists", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "fonts" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const files = walk(path.join(ROOT, "api")).filter((p) => p.endsWith(".js"));
  assert.ok(files.some((p) => path.basename(p) === "_picture.js"), "api/_picture.js exists");
  assert.equal(files.filter((p) => !path.basename(p).startsWith("_")).length, 10);
});
test("_picture.js has no client of its own and does not use cross-bucket copy", () => {
  const src = fs.readFileSync(path.join(ROOT, "api", "_picture.js"), "utf8");
  assert.ok(!/createClient\s*\(/.test(src));
  assert.ok(!/\.copy\s*\(/.test(src));
});
