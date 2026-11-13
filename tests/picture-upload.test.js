"use strict";
// Picture P1: api/picture-upload.js (sign / finish) plus sql/picture-migration.sql. Written test-first from
// the acceptance criteria and the interface contract, offline: Supabase Storage and rpc are stubbed here
// (tests/_fake-supabase.js has no storage, so the storage stub lives in this file).
// Leto decision: finish is ALSO rate limited, 30 per hour per IP.
const SERVICE_KEY = "fake-service-role-key-SECRET-123";
process.env.SUPABASE_URL = "https://fake-project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const test = require("node:test");
require("./_quiet")(test);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { install, makeRes } = require("./_fake-supabase");

const ROOT = path.resolve(__dirname, "..");
const HOUR = 3600, DAY = 86400;
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const RAW = `raw/${UUID}.jpg`;
const OK = `ok/${UUID}.jpg`;
const MAX = 1572864;

// ---- storage + rpc stub ----
let st;
function freshStub() {
  st = {
    calls: [],            // {bucket, op, args}
    rpcCalls: [],
    objects: new Map(),   // path -> Buffer (picture-staging)
    denyWindowLimit: [],  // [[windowS, limit]] pairs that answer false
    rpcFail: null,        // "error" | "throw"
    signError: null, downloadError: null, copyError: null, removeError: null,
  };
}
freshStub();
const storage = {
  from(bucket) {
    const rec = (op, args) => st.calls.push({ bucket, op, args });
    return {
      async createSignedUploadUrl(p) {
        rec("createSignedUploadUrl", [p]);
        if (st.signError) return { data: null, error: st.signError };
        return { data: { signedUrl: `https://fake-project.supabase.co/storage/v1/object/upload/sign/${bucket}/${p}?token=tok123`, token: "tok123", path: "SERVER-IGNORED" }, error: null };
      },
      async download(p) {
        rec("download", [p]);
        if (st.downloadError) return { data: null, error: st.downloadError };
        if (!st.objects.has(p)) return { data: null, error: { message: "Object not found", status: 404, statusCode: "404" } };
        const buf = st.objects.get(p);
        return { data: new Blob([buf]), error: null };
      },
      async copy(from, to) {
        rec("copy", [from, to]);
        if (st.copyError) return { data: null, error: st.copyError };
        st.objects.set(to, st.objects.get(from));
        return { data: { path: to }, error: null };
      },
      async remove(paths) {
        rec("remove", [paths]);
        if (st.removeError) return { data: null, error: st.removeError };
        for (const p of paths) st.objects.delete(p);
        return { data: paths.map((name) => ({ name })), error: null };
      },
      async list(...a) { rec("list", a); return { data: [], error: null }; },
      async listBuckets(...a) { rec("listBuckets", a); return { data: [], error: null }; },
    };
  },
  async listBuckets(...a) { st.calls.push({ bucket: null, op: "listBuckets", args: a }); return { data: [], error: null }; },
};
install({
  storage,
  from: () => { throw new Error("no table access expected in picture-upload"); },
  rpc: async (name, args) => {
    st.rpcCalls.push({ name, args });
    if (st.rpcFail === "throw") throw new Error("rpc boom");
    if (st.rpcFail === "error") return { data: null, error: { code: "PGRST202", message: "function missing" } };
    const denied = st.denyWindowLimit.some(([w, l]) => args.p_window_s === w && args.p_limit === l);
    return { data: !denied, error: null };
  },
});

const SITE = { origin: "https://rsvp.kupernet.com", host: "rsvp.kupernet.com" };
const H = (ip = "203.0.113.7") => ({ ...SITE, "x-forwarded-for": ip });
function handler() { return require("../api/picture-upload"); }
async function call(body, { method = "POST", headers = H() } = {}) {
  const res = makeRes();
  await handler()({ method, headers, body }, res);
  return res;
}
const jpeg = (n = 1000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, 1)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500)]);
const ops = (op) => st.calls.filter((c) => c.op === op);
function assertNoLeak(res) {
  const s = JSON.stringify(res.body) + JSON.stringify(res.headers);
  assert.ok(!s.includes(SERVICE_KEY), "service key leaked");
  assert.ok(!/stack|\bat .*\.js|node_modules/i.test(s), "stack leaked: " + s);
  assert.ok(!/picture-staging|event-pictures|fake-project|supabase/i.test(s.replace(/"uploadUrl":"[^"]*"/, "")), "internals leaked: " + s);
}

// ---------- sign ----------
test("sign: 200 with server-built raw path, signed uploadUrl and token for picture-staging", async () => {
  freshStub();
  const res = await call({ action: "sign" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.path, /^raw\/[0-9a-f-]{36}\.jpg$/);
  assert.notEqual(res.body.path, "SERVER-IGNORED");
  assert.match(res.body.uploadUrl, /^https:\/\//);
  assert.equal(res.body.token, "tok123");
  const c = ops("createSignedUploadUrl");
  assert.equal(c.length, 1);
  assert.equal(c[0].bucket, "picture-staging");
  assert.equal(c[0].args[0], res.body.path);
});

test("sign: every ticket gets a fresh path and ignores user-supplied text", async () => {
  freshStub();
  const a = await call({ action: "sign", path: "raw/evil.jpg", name: "../../x", filename: "a.php" });
  const b = await call({ action: "sign" });
  assert.notEqual(a.body.path, b.body.path);
  assert.match(a.body.path, /^raw\/[0-9a-f-]{36}\.jpg$/);
  assert.ok(!JSON.stringify(st.calls).includes("evil"));
});

test("sign: a JSON string body is parsed", async () => {
  freshStub();
  const res = await call(JSON.stringify({ action: "sign" }));
  assert.equal(res.statusCode, 200);
});

// ---------- refusals ----------
test("OPTIONS answers 200; GET/PUT/DELETE answer 405 with {error}", async () => {
  freshStub();
  assert.equal((await call(undefined, { method: "OPTIONS" })).statusCode, 200);
  for (const m of ["GET", "PUT", "DELETE"]) {
    const r = await call({ action: "sign" }, { method: m });
    assert.equal(r.statusCode, 405, m);
    assert.ok(r.body && r.body.error);
  }
  assert.equal(st.calls.length, 0);
});

test("foreign Origin is refused 403 before any limiter or storage call", async () => {
  freshStub();
  const r = await call({ action: "sign" }, { headers: { origin: "https://evil.example", host: "rsvp.kupernet.com", "x-forwarded-for": "1.2.3.4" } });
  assert.equal(r.statusCode, 403);
  assert.equal(st.rpcCalls.length, 0);
  assert.equal(st.calls.length, 0);
});

test("bad JSON, non-object body and unknown action are 400 before the limiter", async () => {
  freshStub();
  for (const b of ["{not json", "[]", "null", 42, undefined, { action: "list" }, { action: "" }, {}, { action: "SIGN" }]) {
    const r = await call(b);
    assert.equal(r.statusCode, 400, JSON.stringify(b));
  }
  assert.equal(st.rpcCalls.length, 0);
  assert.equal(st.calls.length, 0);
});

// ---------- rate limits ----------
test("sign: limiter is asked per IP hour 10, per IP day 30, global day 100", async () => {
  freshStub();
  await call({ action: "sign" });
  const pairs = st.rpcCalls.map((c) => c.name + ":" + c.args.p_window_s + ":" + c.args.p_limit);
  for (const want of [`rate_limit_hit:${HOUR}:10`, `rate_limit_hit:${DAY}:30`, `rate_limit_hit:${DAY}:100`]) {
    assert.ok(pairs.includes(want), want + " missing in " + pairs);
  }
});

for (const [label, w, l] of [["per IP hour", HOUR, 10], ["per IP day", DAY, 30], ["global day", DAY, 100]]) {
  test(`sign: over the ${label} limit gives 429, Retry-After 3600, no ticket`, async () => {
    freshStub();
    st.denyWindowLimit = [[w, l]];
    const r = await call({ action: "sign" });
    assert.equal(r.statusCode, 429);
    assert.ok(r.body.error && !r.body.uploadUrl && !r.body.token && !r.body.path);
    assert.equal(String(r.headers["Retry-After"]), "3600");
    assert.equal(ops("createSignedUploadUrl").length, 0);
  });
}

test("limiter failure (rpc error or throw) fails open: sign still works", async () => {
  for (const mode of ["error", "throw"]) {
    freshStub();
    st.rpcFail = mode;
    const r = await call({ action: "sign" });
    assert.equal(r.statusCode, 200, mode);
    assert.ok(r.body.uploadUrl);
  }
});

test("finish: limited per IP, 30 per hour; over the limit 429 with no download", async () => {
  freshStub();
  st.objects.set(RAW, jpeg());
  await call({ action: "finish", path: RAW });
  assert.ok(st.rpcCalls.some((c) => c.args.p_window_s === HOUR && c.args.p_limit === 30), JSON.stringify(st.rpcCalls.map((c) => c.args)));
  freshStub();
  st.objects.set(RAW, jpeg());
  st.denyWindowLimit = [[HOUR, 30]];
  const r = await call({ action: "finish", path: RAW });
  assert.equal(r.statusCode, 429);
  assert.equal(ops("download").length, 0);
  assert.ok(st.objects.has(RAW));
});

test("finish: limiter failure fails open", async () => {
  freshStub();
  st.rpcFail = "throw";
  st.objects.set(RAW, jpeg());
  assert.equal((await call({ action: "finish", path: RAW })).statusCode, 200);
});

// ---------- finish: path validation ----------
test("finish: only raw/<36 hex-dash>.jpg is accepted, everything else 400 with no storage call", async () => {
  freshStub();
  const bad = [
    undefined, null, 5, {}, [RAW], "", RAW + "\n", " " + RAW, RAW + "/", "../" + RAW,
    `raw/../${UUID}.jpg`, `raw/${UUID}.jpg/../../x`, `raw//${UUID}.jpg`, `raw/${UUID}.png`, `raw/${UUID}.jpeg`,
    `raw/${UUID}.JPG`, `raw/${UUID.toUpperCase()}.jpg`, `raw/${UUID}`, `ok/${UUID}.jpg`, `RAW/${UUID}.jpg`,
    `raw/${UUID.slice(1)}.jpg`, `raw/${UUID}0.jpg`, `raw/${"g".repeat(36)}.jpg`, `raw/${UUID}.jpg.png`,
    `raw/%2e%2e%2f${UUID}.jpg`, `raw/${UUID}.jpg\0.png`, `picture-staging/${RAW}`, "/" + RAW, `raw\\${UUID}.jpg`,
  ];
  for (const p of bad) {
    const r = await call({ action: "finish", path: p });
    assert.equal(r.statusCode, 400, JSON.stringify(p));
  }
  assert.equal(st.calls.length, 0);
});

// ---------- finish: behaviour ----------
test("finish ok: downloads raw, copies to ok/<same uuid>.jpg, removes raw, returns the ok path", async () => {
  freshStub();
  st.objects.set(RAW, jpeg(2000));
  const r = await call({ action: "finish", path: RAW });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { path: OK });
  assert.deepEqual(ops("copy").map((c) => [c.bucket, ...c.args]), [["picture-staging", RAW, OK]]);
  assert.deepEqual(ops("remove").map((c) => [c.bucket, c.args[0]]), [["picture-staging", [RAW]]]);
  assert.ok(st.objects.has(OK) && !st.objects.has(RAW));
});

test("finish: exactly 1.5 MB and 1 byte (minimal JPEG magic) are accepted", async () => {
  freshStub();
  st.objects.set(RAW, jpeg(MAX));
  assert.equal((await call({ action: "finish", path: RAW })).statusCode, 200);
  freshStub();
  st.objects.set(RAW, Buffer.from([0xff, 0xd8, 0xff]));
  assert.equal((await call({ action: "finish", path: RAW })).statusCode, 200);
});

test("finish: missing object is 404 and nothing is copied or removed", async () => {
  freshStub();
  const r = await call({ action: "finish", path: RAW });
  assert.equal(r.statusCode, 404);
  assert.equal(ops("copy").length, 0);
  assertNoLeak(r);
});

test("finish: download error with status 404 as number or string is 404", async () => {
  for (const e of [{ message: "x", status: 404 }, { message: "x", statusCode: "404" }, { message: "The resource was not found" }]) {
    freshStub();
    st.downloadError = e;
    assert.equal((await call({ action: "finish", path: RAW })).statusCode, 404, JSON.stringify(e));
  }
});

test("finish: PNG bytes are deleted and refused 422", async () => {
  freshStub();
  st.objects.set(RAW, png());
  const r = await call({ action: "finish", path: RAW });
  assert.equal(r.statusCode, 422);
  assert.ok(!st.objects.has(RAW) && !st.objects.has(OK));
  assert.equal(ops("copy").length, 0);
  assert.deepEqual(ops("remove").map((c) => c.args[0]), [[RAW]]);
});

test("finish: oversize and empty objects are deleted and refused 422", async () => {
  for (const buf of [jpeg(MAX + 1), Buffer.alloc(0), Buffer.from([0xff, 0xd8])]) {
    freshStub();
    st.objects.set(RAW, buf);
    const r = await call({ action: "finish", path: RAW });
    assert.equal(r.statusCode, 422, "len " + buf.length);
    assert.ok(!st.objects.has(RAW) && !st.objects.has(OK));
    assert.equal(ops("copy").length, 0);
  }
});

test("finish: download accepting a Buffer/Uint8Array result also works", async () => {
  freshStub();
  const orig = storage.from;
  storage.from = (b) => ({ ...orig(b), async download(p) { st.calls.push({ bucket: b, op: "download", args: [p] }); return { data: new Uint8Array(jpeg()), error: null }; } });
  try {
    st.objects.set(RAW, jpeg());
    assert.equal((await call({ action: "finish", path: RAW })).statusCode, 200);
  } finally { storage.from = orig; }
});

test("finish: copy error is 500 and the raw object is left; remove error after good copy is still 200", async () => {
  freshStub();
  st.objects.set(RAW, jpeg());
  st.copyError = { message: "copy exploded " + SERVICE_KEY };
  const r = await call({ action: "finish", path: RAW });
  assert.equal(r.statusCode, 500);
  assert.ok(st.objects.has(RAW));
  assertNoLeak(r);
  freshStub();
  st.objects.set(RAW, jpeg());
  st.removeError = { message: "remove failed" };
  const r2 = await call({ action: "finish", path: RAW });
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.body, { path: OK });
});

// ---------- errors, leakage, missing buckets ----------
test("missing bucket gives 503 {error:'Picture upload is not available yet'} on sign and finish", async () => {
  freshStub();
  st.signError = { message: "Bucket not found", status: 404 };
  const s = await call({ action: "sign" });
  assert.equal(s.statusCode, 503);
  assert.deepEqual(s.body, { error: "Picture upload is not available yet" });
  freshStub();
  st.downloadError = { message: "Bucket not found", status: 404, statusCode: "404" };
  const f = await call({ action: "finish", path: RAW });
  assert.equal(f.statusCode, 503);
  assert.deepEqual(f.body, { error: "Picture upload is not available yet" });
});

test("other storage failures give 500 {error:'Upload failed'} and leak nothing", async () => {
  freshStub();
  st.signError = { message: `boom picture-staging ${SERVICE_KEY} at Object.<anonymous> (/var/task/x.js:1:1)`, status: 500 };
  const s = await call({ action: "sign" });
  assert.equal(s.statusCode, 500);
  assert.deepEqual(s.body, { error: "Upload failed" });
  assertNoLeak(s);
  freshStub();
  st.downloadError = { message: `db down ${SERVICE_KEY}`, status: 500 };
  const f = await call({ action: "finish", path: RAW });
  assert.equal(f.statusCode, 500);
  assert.deepEqual(f.body, { error: "Upload failed" });
  assertNoLeak(f);
});

test("a thrown exception from storage does not crash the handler and leaks nothing", async () => {
  freshStub();
  const orig = storage.from;
  storage.from = () => { throw new Error("kaboom " + SERVICE_KEY); };
  try {
    const r = await call({ action: "sign" });
    assert.ok(r.statusCode >= 500 && r.statusCode < 600, String(r.statusCode));
    assertNoLeak(r);
  } finally { storage.from = orig; }
});

test("error responses of every refusal kind contain no key, stack or bucket text", async () => {
  freshStub();
  const rs = [
    await call({ action: "sign" }, { method: "GET" }),
    await call("{bad"),
    await call({ action: "finish", path: "../x" }),
    await call({ action: "finish", path: RAW }),
  ];
  st.denyWindowLimit = [[HOUR, 10]];
  rs.push(await call({ action: "sign" }));
  for (const r of rs) assertNoLeak(r);
});

test("no listing call is ever made and event-pictures is never touched", async () => {
  freshStub();
  st.objects.set(RAW, jpeg());
  await call({ action: "sign" });
  await call({ action: "finish", path: RAW });
  st.objects.set(RAW, png());
  await call({ action: "finish", path: RAW });
  await call({ action: "finish", path: `raw/${UUID.replace(/[0-9]/g, "a")}.jpg` });
  assert.equal(st.calls.filter((c) => /^list/.test(c.op)).length, 0);
  assert.equal(st.calls.filter((c) => c.bucket === "event-pictures").length, 0);
  const src = fs.readFileSync(path.join(ROOT, "api/picture-upload.js"), "utf8");
  assert.ok(!/\.list\w*\(/.test(src), "source calls a list function");
  assert.ok(!/picture_path/.test(src), "endpoint must not touch events.picture_path");
});

// ---------- static checks ----------
test("sql/picture-migration.sql exists, only adds, is re-runnable, mentions both buckets", () => {
  const f = path.join(ROOT, "sql/picture-migration.sql");
  assert.ok(fs.existsSync(f), "sql/picture-migration.sql missing");
  const sql = fs.readFileSync(f, "utf8");
  assert.ok(!/\b(drop|delete|truncate)\b/i.test(sql), "destructive keyword");
  assert.match(sql, /add column if not exists picture_path text/i);
  const stmts = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  for (const m of stmts.matchAll(/\bcreate\s+(table|index|function)\b(?!\s+(if not exists|or replace))/gi)) assert.fail("not re-runnable: " + m[0]);
  for (const m of stmts.matchAll(/\balter\s+table[^;]*\badd\s+column\b(?!\s+if not exists)/gi)) assert.fail("not re-runnable: " + m[0]);
  assert.match(sql, /picture-staging/);
  assert.match(sql, /event-pictures/);
});

test("sql/schema.sql mirrors the picture_path column", () => {
  const sql = fs.readFileSync(path.join(ROOT, "sql/schema.sql"), "utf8");
  assert.match(sql, /picture_path text/i);
  assert.match(sql, /add column if not exists picture_path text/i);
});

test("Vercel Hobby budget: at most 12 function files including picture-upload", () => {
  const fns = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== "fonts") walk(p); } else if (p.endsWith(".js") && !e.name.startsWith("_")) fns.push(p); } };
  walk(path.join(ROOT, "api"));
  assert.ok(fns.some((p) => p.endsWith("picture-upload.js")), "api/picture-upload.js missing");
  assert.ok(fns.length <= 12, `${fns.length} functions exceeds 12`);
});

// ---------- Jessica Major 1: limiter keys are really per IP ----------
const { hashId } = require("../api/_ratelimit");
const keysFor = (body) => st.rpcCalls.map((c) => c.args.p_key);

test("sign: hourly/daily keys are hashId(scope, ip); global key is shared across IPs", async () => {
  freshStub();
  await call({ action: "sign" }, { headers: H("198.51.100.1") });
  const a = st.rpcCalls.map((c) => c.args);
  freshStub();
  await call({ action: "sign" }, { headers: H("198.51.100.2") });
  const b = st.rpcCalls.map((c) => c.args);
  const pick = (arr, w, l) => arr.find((x) => x.p_window_s === w && x.p_limit === l).p_key;
  assert.equal(pick(a, HOUR, 10), hashId("pic-ip-h", "198.51.100.1"));
  assert.equal(pick(a, DAY, 30), hashId("pic-ip-d", "198.51.100.1"));
  assert.equal(pick(b, HOUR, 10), hashId("pic-ip-h", "198.51.100.2"));
  assert.notEqual(pick(a, HOUR, 10), pick(b, HOUR, 10));
  assert.notEqual(pick(a, DAY, 30), pick(b, DAY, 30));
  assert.equal(pick(a, DAY, 100), hashId("pic-all", "global"));
  assert.equal(pick(a, DAY, 100), pick(b, DAY, 100));
});

test("finish: hourly key is hashId(pic-fin-ip-h, ip) and differs per IP", async () => {
  const keys = [];
  for (const ip of ["198.51.100.1", "198.51.100.2"]) {
    freshStub();
    st.objects.set(RAW, jpeg());
    await call({ action: "finish", path: RAW }, { headers: H(ip) });
    const hit = st.rpcCalls.find((c) => c.args.p_window_s === HOUR && c.args.p_limit === 30);
    assert.ok(hit, "finish limiter missing");
    assert.equal(hit.args.p_key, hashId("pic-fin-ip-h", ip));
    keys.push(hit.args.p_key);
  }
  assert.notEqual(keys[0], keys[1]);
});

// ---------- Jessica Major 2 delta: Blob size pre-check ----------
function withBlob(makeBlob, fn) {
  return async () => {
    freshStub();
    const orig = storage.from;
    storage.from = (bucket) => {
      const real = orig.call(storage, bucket);
      return { ...real, async download(p) { real.download; st.calls.push({ bucket, op: "download", args: [p] }); return { data: makeBlob(), error: null }; } };
    };
    try { await fn(); } finally { storage.from = orig; }
  };
}

test("finish: Blob.size above 1572864 gives 422, removes raw, never reads the body", withBlob(
  () => ({ size: MAX + 1, arrayBuffer() { throw new Error("arrayBuffer must not be called"); } }),
  async () => {
    const r = await call({ action: "finish", path: RAW });
    assert.equal(r.statusCode, 422);
    assert.equal(ops("remove").length, 1);
    assert.deepEqual(ops("remove")[0].args[0], [RAW]);
    assert.equal(ops("copy").length, 0);
  }));

test("finish: Blob.size exactly 1572864 passes the size gate", withBlob(
  () => ({ size: MAX, async arrayBuffer() { const b = jpeg(1000); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } }),
  async () => {
    const r = await call({ action: "finish", path: RAW });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.path, OK);
  }));

test("finish: Blob without numeric size falls through to read-then-check", async () => {
  for (const [size, expect] of [[undefined, 200], ["big", 200]]) {
    await withBlob(
      () => ({ size, async arrayBuffer() { const b = jpeg(1000); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } }),
      async () => { assert.equal((await call({ action: "finish", path: RAW })).statusCode, expect); })();
  }
  await withBlob(
    () => ({ async arrayBuffer() { return new ArrayBuffer(MAX + 1); } }),
    async () => {
      const r = await call({ action: "finish", path: RAW });
      assert.equal(r.statusCode, 422);
      assert.equal(ops("remove").length, 1);
    })();
});
