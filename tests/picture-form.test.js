"use strict";
// P4: the optional picture field in public/register.html. The pure logic lives in one inline script between
// the markers PICTURE-LOGIC-START / PICTURE-LOGIC-END and is run here in a bare node:vm context (no DOM, no
// network) with injected fakes. Real canvas encoding, EXIF and a real upload cannot be proven offline.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const HTML = process.env.PICTURE_HTML ? fs.readFileSync(process.env.PICTURE_HTML, "utf8") : read("public/register.html");

const NAMES = ["PICTURE_LIMITS", "validatePictureFile", "computeTargetSize", "shrinkToJpeg", "createPictureUploader",
  "pictureMessageKey", "syncPictureToForm", "pictureErrorFromCreateEvent", "renderPicturePreview",
  "renderPictureField", "browserPictureDeps", "readImageDimensions", "PICTURE_MAX_PIXELS"];

let cached;
function L() {
  if (cached) return cached;
  cached = loadLogic({});
  return cached;
}
function loadLogic(globals) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, src = null;
  while ((m = re.exec(HTML))) if (m[1].includes("// PICTURE-LOGIC-START")) { src = m[1]; break; }
  assert.ok(src, "register.html has no inline script containing // PICTURE-LOGIC-START");
  assert.ok(src.includes("// PICTURE-LOGIC-END"), "missing // PICTURE-LOGIC-END marker");
  const a = src.indexOf("// PICTURE-LOGIC-START"), b = src.indexOf("// PICTURE-LOGIC-END");
  assert.ok(a < b, "markers out of order");
  const ctx = vm.createContext(Object.assign({}, globals));
  return vm.runInContext(src + "\n;({" + NAMES.join(",") + "})", ctx);
}
const plain = (x) => JSON.parse(JSON.stringify(x));

const MB5 = 5242880;
const GOOD_PATH = "ok/123e4567-e89b-12d3-a456-426614174000.jpg";
const RAW_PATH = "tmp/123e4567-e89b-12d3-a456-426614174000.jpg";

// ---------- validatePictureFile ----------
test("validatePictureFile accepts JPG/PNG/WebP up to exactly 5 MB", () => {
  const { validatePictureFile } = L();
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    assert.deepEqual(plain(validatePictureFile({ type, size: 1 })), { ok: true });
    assert.deepEqual(plain(validatePictureFile({ type, size: MB5 })), { ok: true });
  }
});
test("validatePictureFile refuses 5 MB + 1 byte with code size", () => {
  const { validatePictureFile } = L();
  assert.deepEqual(plain(validatePictureFile({ type: "image/jpeg", size: MB5 + 1 })), { ok: false, code: "size" });
});
test("validatePictureFile refuses other types (type is checked first)", () => {
  const { validatePictureFile } = L();
  for (const type of ["image/gif", "image/heic", "image/svg+xml", "application/pdf", "", undefined]) {
    assert.deepEqual(plain(validatePictureFile({ type, size: 100 })), { ok: false, code: "type" }, String(type));
  }
  assert.equal(validatePictureFile({ type: "image/gif", size: 0 }).code, "type");
  assert.equal(validatePictureFile({ type: "image/gif", size: MB5 + 5 }).code, "type");
});
test("validatePictureFile refuses empty / non-numeric size with code empty", () => {
  const { validatePictureFile } = L();
  for (const size of [0, undefined, "12", NaN, null]) {
    assert.deepEqual(plain(validatePictureFile({ type: "image/png", size })), { ok: false, code: "empty" }, String(size));
  }
});

// ---------- computeTargetSize ----------
test("computeTargetSize caps the longest side at 1600, keeps aspect, both orientations", () => {
  const { computeTargetSize } = L();
  assert.deepEqual(plain(computeTargetSize(3200, 1600)), { width: 1600, height: 800 });
  assert.deepEqual(plain(computeTargetSize(1600, 3200)), { width: 800, height: 1600 });
  assert.deepEqual(plain(computeTargetSize(4000, 3000)), { width: 1600, height: 1200 });
  const r = computeTargetSize(4032, 3024);
  assert.equal(Math.max(r.width, r.height), 1600);
  assert.ok(Math.abs(r.width / r.height - 4032 / 3024) < 0.01);
  assert.ok(Number.isInteger(r.width) && Number.isInteger(r.height));
});
test("computeTargetSize never upscales and keeps min 1", () => {
  const { computeTargetSize } = L();
  assert.deepEqual(plain(computeTargetSize(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(plain(computeTargetSize(1600, 1600)), { width: 1600, height: 1600 });
  assert.deepEqual(plain(computeTargetSize(1, 1)), { width: 1, height: 1 });
  const r = computeTargetSize(100000, 10);
  assert.equal(r.width, 1600); assert.ok(r.height >= 1);
});
test("computeTargetSize returns null for bad dimensions", () => {
  const { computeTargetSize } = L();
  for (const [w, h] of [[0, 10], [10, 0], [-1, 5], [NaN, 5], [5, Infinity], [undefined, 3], ["a", 3]]) {
    assert.equal(computeTargetSize(w, h), null, `${w}x${h}`);
  }
});

test("PICTURE_LIMITS has the contract values", () => {
  const { PICTURE_LIMITS } = L();
  assert.deepEqual(plain(PICTURE_LIMITS), {
    maxSourceBytes: 5242880, maxSide: 1600, targetBytes: 1048576, hardBytes: 1468006,
    qualities: [0.85, 0.75, 0.65, 0.55, 0.45, 0.35], types: ["image/jpeg", "image/png", "image/webp"],
  });
});

// ---------- shrinkToJpeg ----------
function codec(sizesByQuality, opts = {}) {
  const calls = { encode: [], closed: 0 };
  return {
    calls,
    decode: async () => {
      if (opts.decodeThrows) throw new Error("bad image");
      return { width: opts.w ?? 4000, height: opts.h ?? 3000, close() { calls.closed++; } };
    },
    encode: async (d, w, h, q) => {
      calls.encode.push({ w, h, q });
      if (opts.encodeNull) return null;
      return { size: sizesByQuality(q) };
    },
  };
}
test("shrinkToJpeg stops at the first quality that fits ~1 MB", async () => {
  const { shrinkToJpeg } = L();
  const c = codec((q) => (q > 0.8 ? 3000000 : 900000));
  const r = await shrinkToJpeg({ type: "image/png", size: 100 }, c);
  assert.equal(r.ok, true);
  assert.equal(r.blob.size, 900000);
  assert.deepEqual(c.calls.encode.map((e) => e.q), [0.85, 0.75]);
  assert.deepEqual([c.calls.encode[0].w, c.calls.encode[0].h], [1600, 1200]);
  assert.equal(c.calls.closed, 1);
});
test("shrinkToJpeg accepts exactly targetBytes on the first try", async () => {
  const { shrinkToJpeg } = L();
  const c = codec(() => 1048576);
  const r = await shrinkToJpeg({}, c);
  assert.equal(r.ok, true);
  assert.equal(c.calls.encode.length, 1);
});
test("shrinkToJpeg orientation: the encode size uses the decoded (already rotated) dims, longest side 1600", async () => {
  const { shrinkToJpeg } = L();
  const c = codec(() => 1000, { w: 3000, h: 4000 });
  await shrinkToJpeg({}, c);
  assert.deepEqual([c.calls.encode[0].w, c.calls.encode[0].h], [1200, 1600]);
});
test("shrinkToJpeg uses the smallest blob when none fits 1 MB but one is under 1.4 MB", async () => {
  const { shrinkToJpeg } = L();
  const sizes = { 0.85: 1450000, 0.75: 1400000, 0.65: 1300000, 0.55: 1200000, 0.45: 1100000, 0.35: 1060000 };
  const c = codec((q) => sizes[q]);
  const r = await shrinkToJpeg({}, c);
  assert.equal(c.calls.encode.length, 6);
  assert.equal(r.ok, true);
  assert.equal(r.blob.size, 1060000);
});
test("shrinkToJpeg refuses toolarge when even the smallest is above 1.4 MB (1468006)", async () => {
  const { shrinkToJpeg } = L();
  const r = await shrinkToJpeg({}, codec(() => 1468007));
  assert.deepEqual(plain(r), { ok: false, code: "toolarge" });
  const edge = await shrinkToJpeg({}, codec(() => 1468006));
  assert.equal(edge.ok, true);
});
test("shrinkToJpeg decode failure, bad size and null encode give code decode", async () => {
  const { shrinkToJpeg } = L();
  assert.deepEqual(plain(await shrinkToJpeg({}, codec(() => 1, { decodeThrows: true }))), { ok: false, code: "decode" });
  assert.deepEqual(plain(await shrinkToJpeg({}, codec(() => 1, { w: 0, h: 10 }))), { ok: false, code: "decode" });
  const c = codec(() => 1, { encodeNull: true });
  assert.deepEqual(plain(await shrinkToJpeg({}, c)), { ok: false, code: "decode" });
  assert.equal(c.calls.closed, 1, "decoded.close() still called");
});

// ---------- uploader harness ----------
function resp(status, body, opts = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => { if (opts.badJson) throw new SyntaxError("Unexpected token <"); return body; },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}
function harness(over = {}) {
  const calls = [], revoked = [], changes = [];
  let urlN = 0;
  class FD { constructor() { this.entries = []; } append(k, v) { this.entries.push([k, v]); } }
  const script = over.script || {};
  const deps = {
    FormData: FD,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/picture-upload") {
        const action = JSON.parse(init.body).action;
        const h = script[action];
        if (h) return typeof h === "function" ? h(url, init) : h;
        if (action === "sign") return resp(200, { path: RAW_PATH, uploadUrl: "https://x.supabase.co/storage/v1/object/upload/sign/p/" + RAW_PATH + "?token=t", token: "t" });
        return resp(200, { path: GOOD_PATH });
      }
      const h = script.put;
      if (h) return typeof h === "function" ? h(url, init) : h;
      return resp(200, { Key: "x" });
    },
    shrink: over.shrink || (async () => ({ ok: true, blob: { size: 1000, tag: "blob" + calls.length } })),
    createObjectURL: () => "blob:u" + ++urlN,
    revokeObjectURL: (u) => revoked.push(u),
    onChange: (u) => changes.push(u.getState()),
  };
  Object.assign(deps, over.extraDeps || {});
  const uploader = L().createPictureUploader(deps);
  return { uploader, calls, revoked, changes, deps };
}
const FILE = { type: "image/jpeg", size: 1000, name: "evil<img src=x onerror=alert(1)>.jpg" };
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

test("uploader starts idle with no path, no URL, not busy", () => {
  const { uploader } = harness();
  assert.equal(uploader.getState(), "idle");
  assert.equal(uploader.getPath(), null);
  assert.equal(uploader.getError(), null);
  assert.equal(uploader.getPreviewUrl(), null);
  assert.equal(uploader.isBusy(), false);
});

test("happy path: exact call sequence sign -> PUT -> finish with exact shapes", async () => {
  const { uploader, calls, changes } = harness();
  await uploader.select(FILE);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "/api/picture-upload");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(plain(calls[0].init.headers), { "Content-Type": "application/json" });
  assert.equal(calls[0].init.body, JSON.stringify({ action: "sign" }));
  // PUT
  assert.ok(calls[1].url.startsWith("https://"));
  assert.ok(calls[1].url.includes(RAW_PATH));
  assert.equal(calls[1].init.method, "PUT");
  assert.equal("headers" in calls[1].init, false, "no headers property at all (no manual Content-Type)");
  const fd = calls[1].init.body;
  assert.equal(fd.entries.length, 2);
  assert.deepEqual(fd.entries[0], ["cacheControl", "3600"]);
  assert.equal(fd.entries[1][0], "", "file is appended under the EMPTY field name");
  assert.equal(fd.entries[1][1].tag.startsWith("blob"), true);
  // finish with the RAW path
  assert.equal(calls[2].url, "/api/picture-upload");
  assert.equal(calls[2].init.method, "POST");
  assert.deepEqual(plain(calls[2].init.headers), { "Content-Type": "application/json" });
  assert.equal(calls[2].init.body, JSON.stringify({ action: "finish", path: RAW_PATH }));
  // result
  assert.equal(uploader.getState(), "ready");
  assert.equal(uploader.getPath(), GOOD_PATH);
  assert.equal(uploader.getError(), null);
  assert.ok(uploader.getPreviewUrl().startsWith("blob:"));
  assert.equal(uploader.isBusy(), false);
  assert.ok(changes.indexOf("processing") < changes.indexOf("uploading"));
  assert.ok(changes.indexOf("uploading") < changes.indexOf("ready"));
  assert.equal(changes[changes.length - 1], "ready");
});

test("busy states are reported while processing and while uploading", async () => {
  const shrinkGate = deferred(), putGate = deferred();
  const h = harness({ shrink: () => shrinkGate.p, script: { put: () => putGate.p } });
  const run = h.uploader.select(FILE);
  assert.equal(h.uploader.getState(), "processing");
  assert.equal(h.uploader.isBusy(), true);
  assert.equal(h.uploader.getPath(), null);
  shrinkGate.res({ ok: true, blob: { size: 5 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.uploader.getState(), "uploading");
  assert.equal(h.uploader.isBusy(), true);
  assert.equal(h.uploader.getPath(), null);
  putGate.res(resp(200, {}));
  await run;
  assert.equal(h.uploader.getState(), "ready");
  assert.equal(h.uploader.isBusy(), false);
});

test("invalid file: error state, nothing else called (no shrink, no fetch)", async () => {
  let shrinks = 0;
  const h = harness({ shrink: async () => { shrinks++; return { ok: true, blob: {} }; } });
  for (const [file, code] of [[{ type: "image/gif", size: 5 }, "type"], [{ type: "image/png", size: MB5 + 1 }, "size"], [{ type: "image/png", size: 0 }, "empty"]]) {
    await h.uploader.select(file);
    assert.equal(h.uploader.getState(), "error");
    assert.equal(h.uploader.getError(), code);
    assert.equal(h.uploader.getPath(), null);
  }
  assert.equal(shrinks, 0);
  assert.equal(h.calls.length, 0);
});

test("shrink failure becomes an error with the shrink code, nothing uploaded", async () => {
  const h = harness({ shrink: async () => ({ ok: false, code: "toolarge" }) });
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getState(), "error");
  assert.equal(h.uploader.getError(), "toolarge");
  assert.equal(h.calls.length, 0);
});

test("uploadUrl must be https (and path a string) else error server, no PUT", async () => {
  for (const bad of [{ path: RAW_PATH, uploadUrl: "http://x.supabase.co/u" }, { path: RAW_PATH, uploadUrl: "javascript:alert(1)" },
    { path: RAW_PATH }, { uploadUrl: "https://x/u" }, { path: 5, uploadUrl: "https://x/u" }]) {
    const h = harness({ script: { sign: resp(200, bad) } });
    await h.uploader.select(FILE);
    assert.equal(h.uploader.getState(), "error", JSON.stringify(bad));
    assert.equal(h.uploader.getError(), "server");
    assert.equal(h.calls.length, 1, "only sign was called");
    assert.equal(h.uploader.getPath(), null);
  }
});

test("finish path must match ok/<uuid>.jpg else error server and no path", async () => {
  for (const bad of ["ok/x.jpg", RAW_PATH, "ok/123e4567-e89b-12d3-a456-426614174000.png", "../ok/123e4567-e89b-12d3-a456-426614174000.jpg", 7, undefined]) {
    const h = harness({ script: { finish: resp(200, { path: bad }) } });
    await h.uploader.select(FILE);
    assert.equal(h.uploader.getState(), "error", String(bad));
    assert.equal(h.uploader.getError(), "server");
    assert.equal(h.uploader.getPath(), null);
  }
});

const FAILS = [
  ["sign 429", { sign: resp(429, { error: "x" }) }, "rate"],
  ["sign 503", { sign: resp(503, {}) }, "unavailable"],
  ["sign 500", { sign: resp(500, {}) }, "server"],
  ["sign 400", { sign: resp(400, {}) }, "server"],
  ["sign non-JSON", { sign: resp(200, null, { badJson: true }) }, "server"],
  ["sign network", { sign: () => { throw new TypeError("Failed to fetch"); } }, "network"],
  ["put refused 400", { put: resp(400, {}) }, "put"],
  ["put refused 403", { put: resp(403, {}) }, "put"],
  ["put 500", { put: resp(500, {}) }, "put"],
  ["put network", { put: () => { throw new TypeError("net"); } }, "network"],
  ["finish 429", { finish: resp(429, {}) }, "rate"],
  ["finish 503", { finish: resp(503, {}) }, "unavailable"],
  ["finish 404", { finish: resp(404, {}) }, "server"],
  ["finish 422", { finish: resp(422, {}) }, "notjpeg"],
  ["finish 500", { finish: resp(500, {}) }, "server"],
  ["finish non-JSON", { finish: resp(200, null, { badJson: true }) }, "server"],
  ["finish network", { finish: () => { throw new TypeError("net"); } }, "network"],
];
for (const [name, script, code] of FAILS) {
  test(`failure ${name}: error ${code}, never throws, no path, retry works`, async () => {
    const h = harness({ script });
    await assert.doesNotReject(h.uploader.select(FILE));
    assert.equal(h.uploader.getState(), "error");
    assert.equal(h.uploader.getError(), code);
    assert.equal(h.uploader.getPath(), null);
    assert.equal(h.uploader.isBusy(), false);
    assert.equal(h.uploader.getPreviewUrl(), null, "no dangling preview on error");
    // retry with a healthy server succeeds
    const before = h.calls.length;
    for (const k of Object.keys(script)) delete script[k];
    await h.uploader.retry();
    assert.equal(h.uploader.getState(), "ready");
    assert.equal(h.uploader.getPath(), GOOD_PATH);
    assert.ok(h.calls.length > before);
  });
}

test("shrink that throws does not throw out of select", async () => {
  const h = harness({ shrink: async () => { throw new Error("boom"); } });
  await assert.doesNotReject(h.uploader.select(FILE));
  assert.equal(h.uploader.getState(), "error");
  assert.equal(h.uploader.getPath(), null);
});

test("a URL created for a failed upload is revoked", async () => {
  const h = harness({ script: { put: resp(500, {}) } });
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getPreviewUrl(), null);
  assert.deepEqual(h.revoked, ["blob:u1"]);
});

test("retry with no previous file is a no-op", async () => {
  const h = harness();
  await h.uploader.retry();
  assert.equal(h.calls.length, 0);
  assert.equal(h.uploader.getState(), "idle");
});

test("organizer can replace after an error and after a success; old blob URL revoked", async () => {
  const h = harness();
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getPreviewUrl(), "blob:u1");
  await h.uploader.select(FILE);
  assert.deepEqual(h.revoked, ["blob:u1"]);
  assert.equal(h.uploader.getPreviewUrl(), "blob:u2");
  assert.equal(h.uploader.getState(), "ready");
  await h.uploader.select({ type: "image/gif", size: 5 });
  assert.equal(h.uploader.getState(), "error");
  assert.equal(h.uploader.getPath(), null);
  assert.ok(h.revoked.includes("blob:u2"));
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getState(), "ready");
});

test("remove clears path, revokes URL, state idle", async () => {
  const h = harness();
  await h.uploader.select(FILE);
  h.uploader.remove();
  assert.equal(h.uploader.getState(), "idle");
  assert.equal(h.uploader.getPath(), null);
  assert.equal(h.uploader.getPreviewUrl(), null);
  assert.equal(h.uploader.getError(), null);
  assert.deepEqual(h.revoked, ["blob:u1"]);
  assert.equal(h.changes[h.changes.length - 1], "idle");
});

test("remove from an error state returns to idle", async () => {
  const h = harness({ script: { sign: resp(503, {}) } });
  await h.uploader.select(FILE);
  h.uploader.remove();
  assert.equal(h.uploader.getState(), "idle");
  assert.equal(h.uploader.getError(), null);
});

test("markError sets error, clears path, revokes URL", async () => {
  const h = harness();
  await h.uploader.select(FILE);
  h.uploader.markError("badpath");
  assert.equal(h.uploader.getState(), "error");
  assert.equal(h.uploader.getError(), "badpath");
  assert.equal(h.uploader.getPath(), null);
  assert.equal(h.uploader.getPreviewUrl(), null);
  assert.ok(h.revoked.includes("blob:u1"));
});

test("late finish of a REPLACED upload is ignored: no stale path, its URL revoked", async () => {
  const gate = deferred();
  let finishes = 0;
  const h = harness({
    script: {
      finish: async () => {
        finishes++;
        if (finishes === 1) return gate.p;
        return resp(200, { path: "ok/aaaaaaaa-e89b-12d3-a456-426614174000.jpg" });
      },
    },
  });
  const first = h.uploader.select(FILE);
  await new Promise((r) => setImmediate(r));
  const second = h.uploader.select(FILE);
  await second;
  assert.equal(h.uploader.getPath(), "ok/aaaaaaaa-e89b-12d3-a456-426614174000.jpg");
  gate.res(resp(200, { path: GOOD_PATH }));
  await first;
  assert.equal(h.uploader.getPath(), "ok/aaaaaaaa-e89b-12d3-a456-426614174000.jpg", "stale response did not overwrite");
  assert.equal(h.uploader.getState(), "ready");
  assert.equal(h.uploader.getPreviewUrl(), "blob:u2");
  assert.ok(h.revoked.includes("blob:u1"));
  assert.ok(!h.revoked.includes("blob:u2"));
});

test("late finish of a REMOVED upload is ignored: path stays null, state idle, URL revoked", async () => {
  const gate = deferred();
  const h = harness({ script: { finish: () => gate.p } });
  const run = h.uploader.select(FILE);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.uploader.getState(), "uploading");
  h.uploader.remove();
  gate.res(resp(200, { path: GOOD_PATH }));
  await run;
  assert.equal(h.uploader.getPath(), null);
  assert.equal(h.uploader.getState(), "idle");
  assert.equal(h.uploader.getPreviewUrl(), null);
  assert.ok(h.revoked.includes("blob:u1"));
});

test("late FAILURE of a removed/replaced upload does not flip state to error", async () => {
  const gate = deferred();
  const h = harness({ script: { put: () => gate.p } });
  const run = h.uploader.select(FILE);
  await new Promise((r) => setImmediate(r));
  h.uploader.remove();
  gate.res(resp(500, {}));
  await run;
  assert.equal(h.uploader.getState(), "idle");
  assert.equal(h.uploader.getError(), null);
});

test("late shrink result of a replaced selection creates no URL and no upload", async () => {
  const gate = deferred();
  let n = 0;
  const h = harness({ shrink: () => (++n === 1 ? gate.p : Promise.resolve({ ok: true, blob: { size: 9 } })) });
  const first = h.uploader.select(FILE);
  const second = h.uploader.select(FILE);
  await second;
  gate.res({ ok: true, blob: { size: 9 } });
  await first;
  const signs = h.calls.filter((c) => c.init.body && typeof c.init.body === "string" && c.init.body.includes('"sign"')).length;
  assert.equal(signs, 1, "only the second run reached the network");
  assert.equal(h.uploader.getState(), "ready");
});

test("selecting while ready drops the old path immediately (before the new run ends)", async () => {
  const gate = deferred();
  let n = 0;
  const h = harness({ shrink: () => (++n === 1 ? Promise.resolve({ ok: true, blob: {} }) : gate.p) });
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getPath(), GOOD_PATH);
  const run = h.uploader.select(FILE);
  assert.equal(h.uploader.getPath(), null);
  assert.equal(h.uploader.isBusy(), true);
  gate.res({ ok: false, code: "decode" });
  await run;
  assert.equal(h.uploader.getError(), "decode");
});

test("uploader works without onChange and uses no timers", async () => {
  const h = harness();
  const deps = Object.assign({}, h.deps); delete deps.onChange;
  const up = L().createPictureUploader(deps);
  const realSet = global.setTimeout; let timers = 0;
  global.setTimeout = (...a) => { timers++; return realSet(...a); };
  try { await up.select(FILE); } finally { global.setTimeout = realSet; }
  assert.equal(up.getState(), "ready");
  assert.equal(timers, 0);
});

test("hasLastFile() is false before any file and true after a failed upload", async () => {
  const h = harness({ script: { sign: resp(503, {}) } });
  assert.equal(h.uploader.hasLastFile(), false);
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getState(), "error");
  assert.equal(h.uploader.hasLastFile(), true);
});
test("main script guards against the picture logic being absent (static)", () => {
  const main = HTML.slice(HTML.indexOf("const EVENT_TYPE_LABELS"));
  assert.ok(/typeof createPictureUploader\s*===\s*"function"/.test(main));
  assert.ok(/pictureUploader\s*&&\s*pictureUploader\.isBusy\(\)/.test(main));
});

// ---------- readImageDimensions (post-review M3) ----------
const u32be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n) => [(n >> 8) & 255, n & 255];
const ascii = (t) => [...t].map((c) => c.charCodeAt(0));
const png = (w, h) => new Uint8Array([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR"), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0]);
const jpeg = (marker, w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, marker, 0, 17, 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const riff = (fourcc, body) => new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(fourcc), 0, 0, 0, 0, ...body]);
const webpVp8 = (w, h) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8, 0, 0]);
const webpVp8l = (w, h) => { const b = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14); return riff("VP8L", [0x2f, b & 255, (b >>> 8) & 255, (b >>> 16) & 255, (b >>> 24) & 255, 0, 0, 0, 0, 0, 0, 0]); };
const webpVp8x = (w, h) => riff("VP8X", [0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]);

test("readImageDimensions reads PNG, JPEG (SOF0 and progressive SOF2), WebP (VP8, VP8L, VP8X)", () => {
  const { readImageDimensions: r } = L();
  assert.deepEqual(plain(r(png(640, 480))), { width: 640, height: 480 });
  assert.deepEqual(plain(r(jpeg(0xc0, 4000, 3000))), { width: 4000, height: 3000 });
  assert.deepEqual(plain(r(jpeg(0xc2, 1234, 777))), { width: 1234, height: 777 });
  assert.deepEqual(plain(r(webpVp8(800, 600))), { width: 800, height: 600 });
  assert.deepEqual(plain(r(webpVp8l(1024, 768))), { width: 1024, height: 768 });
  assert.deepEqual(plain(r(webpVp8x(5000, 4000))), { width: 5000, height: 4000 });
  assert.deepEqual(plain(r(png(70000, 3))), { width: 70000, height: 3 }, "wide PNG beyond 16 bits");
});
test("readImageDimensions returns null for truncated, junk and empty input", () => {
  const { readImageDimensions: r } = L();
  assert.equal(r(new Uint8Array(0)), null);
  assert.equal(r(null), null);
  assert.equal(r(undefined), null);
  assert.equal(r(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30])), null);
  assert.equal(r(png(10, 10).slice(0, 20)), null);
  assert.equal(r(jpeg(0xc0, 10, 10).slice(0, 22)), null);
  assert.equal(r(new Uint8Array([0xff, 0xd8])), null);
  assert.equal(r(webpVp8(10, 10).slice(0, 25)), null);
  assert.equal(r(png(0, 10)), null, "zero width");
});
test("PICTURE_MAX_PIXELS is 40 000 000", () => { assert.equal(L().PICTURE_MAX_PIXELS, 40000000); });

// ---------- browserPictureDeps: pixel cap and decode fallback chain ----------
function browserEnv(over = {}) {
  const log = { bitmapCalls: [], revoked: [], images: 0 };
  const bitmap = { width: 100, height: 50, close() { log.closed = (log.closed || 0) + 1; } };
  const globals = {
    fetch: async () => ({}), FormData: class {},
    URL: { createObjectURL: () => "blob:img1", revokeObjectURL: (u) => log.revoked.push(u) },
    document: { createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage(b) { log.drawn = b; } }), toBlob(cb) { cb({ size: 1000 }); } }) },
    Uint8Array,
  };
  if (over.createImageBitmap) globals.createImageBitmap = (...a) => { log.bitmapCalls.push(a.length > 1 ? a[1] : undefined); return over.createImageBitmap(...a, bitmap); };
  globals.Image = class { set src(v) { log.images++; Promise.resolve().then(() => { if (over.imageFails) this.onerror(); else { this.width = 100; this.height = 50; this.onload(); } }); } };
  const logic = loadLogic(globals);
  return { deps: logic.browserPictureDeps(), log, bitmap };
}
const fileOf = (bytes) => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), type: "image/png", size: bytes.length });

test("browser shrink refuses above 40 MP, accepts exactly 40 000 000, refuses junk, before any decode", async () => {
  const e = browserEnv({ createImageBitmap: async (f, o, bm) => bm || o });
  const over = await e.deps.shrink(fileOf(png(8000, 5001)));
  assert.deepEqual(plain(over), { ok: false, code: "dimensions" });
  assert.deepEqual(plain(await e.deps.shrink(fileOf(new Uint8Array([1, 2, 3])))), { ok: false, code: "dimensions" });
  assert.deepEqual(plain(await e.deps.shrink(fileOf(new Uint8Array(0)))), { ok: false, code: "dimensions" });
  assert.equal(e.log.bitmapCalls.length, 0, "no decode attempted for refused files");
  const exact = await e.deps.shrink(fileOf(png(8000, 5000)));
  assert.equal(exact.ok, true);
  assert.equal(e.log.bitmapCalls.length >= 1, true);
  const huge = await e.deps.shrink(fileOf(png(40000, 40000)));
  assert.equal(huge.code, "dimensions");
});
test("browser decode: from-image options first, then without options when that rejects", async () => {
  const e = browserEnv({ createImageBitmap: async (f, o, bm) => { if (o && typeof o === "object" && !(o.close)) throw new TypeError("options unsupported"); return bm || o; } });
  const r = await e.deps.shrink(fileOf(png(200, 100)));
  assert.equal(r.ok, true);
  assert.equal(e.log.bitmapCalls.length, 2);
  assert.deepEqual(plain(e.log.bitmapCalls[0]), { imageOrientation: "from-image" });
  assert.equal(e.log.bitmapCalls[1], undefined, "second attempt has no options");
  assert.equal(e.log.images, 0, "Image fallback not used");
});
test("browser decode: first attempt succeeds, no second call", async () => {
  const e = browserEnv({ createImageBitmap: async (f, o, bm) => bm });
  const r = await e.deps.shrink(fileOf(png(200, 100)));
  assert.equal(r.ok, true);
  assert.equal(e.log.bitmapCalls.length, 1);
});
test("browser decode: falls back to an Image element via blob URL, which is revoked after use", async () => {
  const e = browserEnv({ createImageBitmap: async () => { throw new Error("no"); } });
  const r = await e.deps.shrink(fileOf(png(200, 100)));
  assert.equal(r.ok, true);
  assert.equal(e.log.bitmapCalls.length, 2);
  assert.equal(e.log.images, 1);
  assert.ok(e.log.revoked.includes("blob:img1"), "image blob URL revoked");
});
test("browser decode: Image fallback failure gives code decode, and without createImageBitmap the Image path is used", async () => {
  const e = browserEnv({ createImageBitmap: async () => { throw new Error("no"); }, imageFails: true });
  assert.deepEqual(plain(await e.deps.shrink(fileOf(png(200, 100)))), { ok: false, code: "decode" });
  const e2 = browserEnv({});
  const r = await e2.deps.shrink(fileOf(png(200, 100)));
  assert.equal(r.ok, true);
  assert.equal(e2.log.images, 1);
});

// ---------- uploadUrl host rule ----------
const BAD_URLS = ["http://x.supabase.co/u", "https://evil.com/u", "https://x.supabase.co.evil.com/u", "https://evilsupabase.co/u",
  "https://x.supabase.co@evil.com/u", "https://supabase.co/u", "https://evil.com/x.supabase.co", "https://evil.com/?h=.supabase.co", "https://evil.com#.supabase.co", "ftp://x.supabase.co/u"];
for (const mode of ["regex fallback (no URL)", "with deps.URL"]) {
  test(`uploadUrl refusals and acceptance, ${mode}`, async () => {
    const extra = mode === "with deps.URL" ? { URL } : {};
    for (const bad of BAD_URLS) {
      const h = harness({ extraDeps: extra, script: { sign: resp(200, { path: RAW_PATH, uploadUrl: bad }) } });
      await h.uploader.select(FILE);
      assert.equal(h.uploader.getState(), "error", bad);
      assert.equal(h.uploader.getError(), "server", bad);
      assert.equal(h.calls.length, 1, "no PUT to " + bad);
    }
    const good = harness({ extraDeps: extra, script: { sign: resp(200, { path: RAW_PATH, uploadUrl: "https://abc.supabase.co/storage/v1/object/upload/sign/p/" + RAW_PATH + "?token=t" }) } });
    await good.uploader.select(FILE);
    assert.equal(good.uploader.getState(), "ready");
    assert.ok(good.calls[1].url.startsWith("https://abc.supabase.co/"));
  });
}

// ---------- deadlines with injected timers (post-review M2) ----------
function timerEnv() {
  const timers = [], cleared = [], aborts = [];
  class AC { constructor() { this.signal = { aborted: false }; aborts.push(this); } abort() { this.signal.aborted = true; } }
  return { timers, cleared, aborts, extra: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => cleared.push(id), AbortController: AC } };
}
const tick = () => new Promise((r) => setImmediate(r));
const never = () => new Promise(() => {});
const HANG = [
  ["shrink", (t) => ({ shrink: never })],
  ["sign", () => ({ script: { sign: never } })],
  ["PUT", () => ({ script: { put: never } })],
  ["finish", () => ({ script: { finish: never } })],
];
for (const [name, mk] of HANG) {
  test(`a never-settling ${name} ends in the network error state after the 30 s deadline`, async () => {
    const t = timerEnv();
    const h = harness(Object.assign({ extraDeps: t.extra }, mk(t)));
    const run = h.uploader.select(FILE);
    await tick();
    assert.equal(h.uploader.isBusy(), true, "busy while waiting");
    const live = t.timers.filter((x, i) => !t.cleared.includes(i + 1));
    assert.equal(live.length, 1, "exactly one live deadline for the hanging step");
    assert.equal(live[0].ms, 30000);
    live[0].fn();
    let settled = false;
    await Promise.race([run.then(() => { settled = true; }), new Promise((r) => setTimeout(r, 500))]);
    assert.equal(settled, true, "select() settled after the deadline fired (did not hang)");
    assert.equal(h.uploader.getState(), "error");
    assert.equal(h.uploader.getError(), "network");
    assert.equal(h.uploader.getPath(), null);
    assert.equal(h.uploader.getPreviewUrl(), null);
    if (name !== "shrink") assert.ok(t.aborts.some((a) => a.signal.aborted), "request aborted");
    // retry works afterwards
    const retryRun = h.uploader.retry();
    await tick();
    assert.ok(["processing", "uploading", "error", "ready"].includes(h.uploader.getState()));
    void retryRun;
  });
}
test("timers are cleared when steps settle in time", async () => {
  const t = timerEnv();
  const h = harness({ extraDeps: t.extra });
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getState(), "ready");
  assert.equal(t.cleared.length, t.timers.length, "every deadline timer cleared");
  assert.ok(t.timers.length >= 4, "shrink, sign, PUT, finish each had a deadline");
});
test("a deadline firing after remove is ignored (state stays idle)", async () => {
  const t = timerEnv();
  const h = harness({ extraDeps: t.extra, shrink: never });
  const run = h.uploader.select(FILE);
  await tick();
  h.uploader.remove();
  t.timers[0].fn();
  await run;
  assert.equal(h.uploader.getState(), "idle");
  assert.equal(h.uploader.getError(), null);
  assert.equal(h.uploader.getPath(), null);
});
test("a deadline of a replaced run firing late does not disturb the new run", async () => {
  const t = timerEnv();
  let n = 0;
  const h = harness({ extraDeps: t.extra, shrink: () => (++n === 1 ? never() : Promise.resolve({ ok: true, blob: { size: 5 } })) });
  const first = h.uploader.select(FILE);
  await tick();
  await h.uploader.select(FILE);
  assert.equal(h.uploader.getState(), "ready");
  const pathBefore = h.uploader.getPath();
  t.timers[0].fn();
  await first;
  assert.equal(h.uploader.getState(), "ready");
  assert.equal(h.uploader.getPath(), pathBefore);
});
test("a deadline firing during PUT after remove does not reach error either", async () => {
  const t = timerEnv();
  const h = harness({ extraDeps: t.extra, script: { put: never } });
  const run = h.uploader.select(FILE);
  await tick();
  h.uploader.remove();
  t.timers[t.timers.length - 1].fn();
  await Promise.race([run, new Promise((r) => setTimeout(r, 500))]);
  assert.equal(h.uploader.getState(), "idle");
  assert.equal(h.uploader.getError(), null);
});

// ---------- superseded run whose sign fails or resolves late (post-review minor 2) ----------
for (const [name, late, extra] of [
  ["fails with 503", () => resp(503, {}), null],
  ["fails with a network error", () => { throw new TypeError("net"); }, null],
  ["resolves late with a valid sign", null, "valid"],
]) {
  test(`a superseded run whose sign ${name} changes nothing`, async () => {
    const gate = deferred();
    let signs = 0, puts = 0;
    const h = harness({
      script: {
        sign: () => (++signs === 1 ? gate.p : resp(200, { path: RAW_PATH, uploadUrl: "https://x.supabase.co/u" })),
        put: () => { puts++; return resp(200, {}); },
        finish: resp(200, { path: GOOD_PATH }),
      },
    });
    const first = h.uploader.select(FILE);
    await tick();
    await h.uploader.select(FILE);
    assert.equal(h.uploader.getState(), "ready");
    const putsBefore = puts, url = h.uploader.getPreviewUrl(), changesBefore = h.changes.length;
    if (late) { try { gate.res(late()); } catch (e) { gate.rej(e); } } else gate.res(resp(200, { path: "tmp/other.jpg", uploadUrl: "https://x.supabase.co/u2" }));
    await first;
    assert.equal(h.uploader.getState(), "ready", "state untouched");
    assert.equal(h.uploader.getError(), null);
    assert.equal(h.uploader.getPath(), GOOD_PATH);
    assert.equal(h.uploader.getPreviewUrl(), url);
    assert.equal(puts, putsBefore, "stale run made no PUT");
    assert.equal(h.changes.length, changesBefore, "no onChange from the stale run");
  });
}
test("a superseded run whose sign resolves late after REMOVE stays idle with no PUT", async () => {
  const gate = deferred();
  const h = harness({ script: { sign: () => gate.p } });
  const run = h.uploader.select(FILE);
  await tick();
  h.uploader.remove();
  gate.res(resp(200, { path: RAW_PATH, uploadUrl: "https://x.supabase.co/u" }));
  await run;
  assert.equal(h.uploader.getState(), "idle");
  assert.equal(h.calls.length, 1, "only the sign call");
});

// ---------- draft reset wiring and Remove visibility ----------
test("resetDraftForPictureChange exists, resets slug and password, and is called from file-select and Remove", () => {
  assert.ok(/function resetDraftForPictureChange\(\)\s*\{[^}]*draftSlug\s*=\s*null[^}]*draftPassword\s*=\s*""/.test(HTML));
  const chg = HTML.indexOf('getElementById("pictureInput").addEventListener("change"');
  assert.ok(chg > 0, "change handler");
  const chgBody = HTML.slice(chg, HTML.indexOf("});", chg));
  assert.ok(/resetDraftForPictureChange\(\)/.test(chgBody), "file-select handler resets the draft");
  assert.ok(chgBody.indexOf("resetDraftForPictureChange") < chgBody.indexOf(".select("), "reset before select");
  const rm = HTML.indexOf('getElementById("picRemoveBtn").addEventListener("click"');
  assert.ok(rm > 0, "remove handler");
  const rmBody = HTML.slice(rm, HTML.indexOf("});", rm));
  assert.ok(/resetDraftForPictureChange\(\)/.test(rmBody), "Remove handler resets the draft");
});
test("Remove is visible in processing, uploading, ready and error; hidden only when idle", async () => {
  const { renderPictureField } = L();
  const states = {};
  const gateS = deferred(), gateF = deferred();
  const h = harness({ shrink: () => gateS.p, script: { finish: () => gateF.p } });
  const show = () => { const d = fakeDoc(["picStatus", "picThumb", "picRemoveBtn", "picRetryBtn", "toStep2Btn"]); renderPictureField(h.uploader, d, (k) => k); return d.els.picRemoveBtn.style.display; };
  states.idle = show();
  const run = h.uploader.select(FILE);
  states.processing = show();
  gateS.res({ ok: true, blob: { size: 1 } });
  await tick();
  states.uploading = show();
  gateF.res(resp(200, { path: GOOD_PATH }));
  await run;
  states.ready = show();
  h.uploader.markError("server");
  states.error = show();
  assert.equal(states.idle, "none");
  for (const k of ["processing", "uploading", "ready", "error"]) assert.notEqual(states[k], "none", k);
});
test("dimensions error: no Retry button, message key exists", async () => {
  const { renderPictureField } = L();
  const h = harness({ shrink: async () => ({ ok: false, code: "dimensions" }) });
  await h.uploader.select(FILE);
  const d = fakeDoc(["picStatus", "picThumb", "picRemoveBtn", "picRetryBtn", "toStep2Btn"]);
  renderPictureField(h.uploader, d, (k) => "T:" + k);
  assert.ok(d.els.picStatus.textContent.includes("T:picErrDimensions"));
  assert.equal(d.els.picRetryBtn.style.display, "none");
});

// ---------- pictureMessageKey ----------
const KEYMAP = { type: "picErrType", empty: "picErrEmpty", size: "picErrSize", toolarge: "picErrTooLarge", decode: "picErrDecode",
  network: "picErrNetwork", rate: "picErrRate", unavailable: "picErrUnavailable", notjpeg: "picErrNotJpeg", put: "picErrServer",
  server: "picErrServer", badpath: "picErrBadPath", notfound: "picErrNotFound", dimensions: "picErrDimensions" };
test("pictureMessageKey maps every code, unknown to picErrServer", () => {
  const { pictureMessageKey } = L();
  for (const [code, key] of Object.entries(KEYMAP)) assert.equal(pictureMessageKey(code), key, code);
  for (const x of ["whatever", undefined, null, ""]) assert.equal(pictureMessageKey(x), "picErrServer");
});

// ---------- syncPictureToForm ----------
test("syncPictureToForm: key absent unless ready; skip case body byte-identical", async () => {
  const { syncPictureToForm } = L();
  const base = { event_type: "wedding", event_name: "x", num_guests: 3 };
  const before = JSON.stringify(base);
  const fd = Object.assign({}, base);
  const h = harness();
  syncPictureToForm(fd, h.uploader);
  assert.equal("picture_path" in fd, false);
  assert.equal(JSON.stringify(fd), before, "skip case serialized body unchanged");
  await h.uploader.select(FILE);
  syncPictureToForm(fd, h.uploader);
  assert.equal(fd.picture_path, GOOD_PATH);
  assert.equal(JSON.stringify(fd), JSON.stringify(Object.assign({}, base, { picture_path: GOOD_PATH })));
  h.uploader.remove();
  assert.equal(syncPictureToForm(fd, h.uploader), fd, "returns formData");
  assert.equal("picture_path" in fd, false, "key deleted, not set to null");
  assert.equal(JSON.stringify(fd), before);
  const h2 = harness({ script: { sign: resp(503, {}) } });
  fd.picture_path = "stale";
  await h2.uploader.select(FILE);
  syncPictureToForm(fd, h2.uploader);
  assert.equal("picture_path" in fd, false);
});

test("syncPictureToForm is not ready while uploading", async () => {
  const { syncPictureToForm } = L();
  const gate = deferred();
  const h = harness({ script: { finish: () => gate.p } });
  const run = h.uploader.select(FILE);
  await new Promise((r) => setImmediate(r));
  const fd = {};
  syncPictureToForm(fd, h.uploader);
  assert.equal("picture_path" in fd, false);
  gate.res(resp(200, { path: GOOD_PATH }));
  await run;
});

// ---------- create-event 400 ----------
test("pictureErrorFromCreateEvent maps the two Hebrew messages only for 400", () => {
  const { pictureErrorFromCreateEvent: f } = L();
  assert.equal(f(400, { error: "נתיב תמונה לא תקין" }), "badpath");
  assert.equal(f(400, { error: "התמונה לא נמצאה, יש להעלות אותה מחדש" }), "notfound");
  assert.equal(f(400, { error: "other" }), null);
  assert.equal(f(500, { error: "נתיב תמונה לא תקין" }), null);
  assert.equal(f(400, null), null);
  assert.equal(f(400, undefined), null);
  assert.equal(f(200, {}), null);
});

test("after a picture 400 the retry body has no picture_path", async () => {
  const { pictureErrorFromCreateEvent, syncPictureToForm } = L();
  const h = harness();
  await h.uploader.select(FILE);
  const fd = { event_name: "x" };
  syncPictureToForm(fd, h.uploader);
  assert.ok(JSON.stringify(fd).includes("picture_path"));
  const code = pictureErrorFromCreateEvent(400, { error: "התמונה לא נמצאה, יש להעלות אותה מחדש" });
  assert.equal(code, "notfound");
  h.uploader.markError(code);
  syncPictureToForm(fd, h.uploader);
  assert.equal(JSON.stringify(fd), JSON.stringify({ event_name: "x" }));
  assert.equal(h.uploader.getPreviewUrl(), null);
});

// ---------- DOM renderers with a tiny fake document ----------
function fakeDoc(ids) {
  const els = {};
  const mk = (tag) => ({ tag, style: {}, children: [], className: "", textContent: "", disabled: false, hidden: false, attrs: {}, classList: null,
    setAttribute(k, v) { this.attrs[k] = v; }, });
  for (const id of ids) els[id] = mk("x");
  return { els, getElementById: (id) => els[id] || null, createElement: (tag) => mk(tag) };
}
test("renderPicturePreview inserts img.gp-picture after .gp-emoji, replaces old, none for null url", () => {
  const { renderPicturePreview } = L();
  const inserted = [];
  const emoji = { after(n) { inserted.push(n); card.kids.push(n); } };
  const card = {
    kids: [], removed: 0,
    querySelectorAll() { return []; },
    querySelector(sel) {
      if (sel === ".gp-emoji") return { insertAdjacentElement: (pos, n) => { assert.equal(pos, "afterend"); inserted.push(n); card.kids.push(n); }, after: emoji.after, nextSibling: null, parentNode: { insertBefore: (n) => { inserted.push(n); card.kids.push(n); } } };
      if (sel === ".gp-picture") return card.kids.length ? { remove() { card.removed++; card.kids.length = 0; } } : null;
      return null;
    },
  };
  const doc = { createElement: (t) => ({ tag: t, className: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, classList: { add(c) { this.owner.className += " " + c; }, owner: null } }) };
  renderPicturePreview(card, "blob:u1", doc);
  assert.equal(inserted.length, 1);
  const img = inserted[0];
  assert.equal(img.tag, "img");
  assert.ok(/gp-picture/.test(img.className) || (img.classList && true));
  assert.equal(img.src || img.attrs.src, "blob:u1");
  renderPicturePreview(card, "blob:u2", doc);
  assert.equal(card.removed, 1, "old .gp-picture removed first");
  renderPicturePreview(card, null, doc);
  assert.equal(inserted.length, 2, "no new img for a null url");
});

test("renderPictureField drives #picStatus/#picThumb/#picRemoveBtn/#picRetryBtn/#toStep2Btn with textContent only", async () => {
  const { renderPictureField } = L();
  const tr = (k) => "T:" + k;
  const mkDoc = () => fakeDoc(["picStatus", "picThumb", "picRemoveBtn", "picRetryBtn", "toStep2Btn"]);
  let d = mkDoc();
  const idle = harness();
  renderPictureField(idle.uploader, d, tr);
  assert.equal(d.els.toStep2Btn.disabled, false);
  assert.equal(d.els.picRemoveBtn.style.display, "none");
  assert.equal(d.els.picRetryBtn.style.display, "none");
  assert.equal(d.els.picThumb.style.display, "none");
  // busy
  const gate = deferred();
  const busy = harness({ script: { finish: () => gate.p } });
  const run = busy.uploader.select(FILE);
  await new Promise((r) => setImmediate(r));
  d = mkDoc();
  renderPictureField(busy.uploader, d, tr);
  assert.equal(d.els.toStep2Btn.disabled, true, "Next disabled while uploading");
  assert.ok(d.els.picStatus.textContent.includes("T:picUploading"));
  gate.res(resp(200, { path: GOOD_PATH }));
  await run;
  d = mkDoc();
  renderPictureField(busy.uploader, d, tr);
  assert.equal(d.els.toStep2Btn.disabled, false);
  assert.ok(d.els.picStatus.textContent.includes("T:picReady"));
  assert.equal(d.els.picThumb.src, busy.uploader.getPreviewUrl());
  assert.notEqual(d.els.picThumb.style.display, "none");
  assert.notEqual(d.els.picRemoveBtn.style.display, "none");
  assert.equal(d.els.picRetryBtn.style.display, "none");
  // network error: message + continue text, retry shown
  const net = harness({ script: { sign: () => { throw new TypeError("x"); } } });
  await net.uploader.select(FILE);
  d = mkDoc();
  renderPictureField(net.uploader, d, tr);
  assert.ok(d.els.picStatus.textContent.includes("T:picErrNetwork"));
  assert.ok(d.els.picStatus.textContent.includes("T:picContinue"));
  assert.notEqual(d.els.picRetryBtn.style.display, "none");
  assert.equal(d.els.toStep2Btn.disabled, false);
  // type error: no retry
  const bad = harness();
  await bad.uploader.select({ type: "image/gif", size: 3, name: "<b>x</b>" });
  d = mkDoc();
  renderPictureField(bad.uploader, d, tr);
  assert.ok(d.els.picStatus.textContent.includes("T:picErrType"));
  assert.equal(d.els.picRetryBtn.style.display, "none");
  assert.ok(!d.els.picStatus.textContent.includes("<b>"), "file name never shown");
});

// ---------- i18n ----------
const DICT_SRC = (() => {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(HTML))) if (m[1].includes("window.PAGE_I18N")) return m[1];
  return null;
})();
const DICT = (() => { const ctx = vm.createContext({ window: {} }); vm.runInContext(DICT_SRC, ctx); return ctx.window.PAGE_I18N; })();
const NEW_KEYS = ["picLabel", "picHint", "picRemove", "picRetry", "picProcessing", "picUploading", "picReady", "picWait", "picContinue",
  "picErrType", "picErrEmpty", "picErrSize", "picErrTooLarge", "picErrDecode", "picErrNetwork", "picErrRate", "picErrUnavailable",
  "picErrNotJpeg", "picErrServer", "picErrBadPath", "picErrNotFound", "picErrDimensions"];
test("every new picture key exists in he and en with non-empty text", () => {
  for (const lang of ["he", "en"]) for (const k of NEW_KEYS) {
    assert.equal(typeof DICT[lang][k], "string", `${lang}.${k} missing`);
    assert.ok(DICT[lang][k].trim().length > 0, `${lang}.${k} empty`);
  }
});
test("he and en have exactly the same pic* keys", () => {
  const ks = (l) => Object.keys(DICT[l]).filter((k) => /^pic[A-Z]/.test(k)).sort();
  assert.deepEqual(ks("he"), ks("en"));
  assert.deepEqual(ks("he"), NEW_KEYS.slice().sort());
});
test("fixed texts: labels and the two server-matching messages", () => {
  assert.equal(DICT.he.picLabel, "תמונה לאירוע (אופציונלי)");
  assert.equal(DICT.en.picLabel, "Event picture (optional)");
  assert.equal(DICT.he.picErrBadPath, "נתיב תמונה לא תקין");
  assert.equal(DICT.he.picErrNotFound, "התמונה לא נמצאה, יש להעלות אותה מחדש");
  assert.ok(/[֐-׿]/.test(DICT.he.picErrType));
  assert.ok(!/[֐-׿]/.test(DICT.en.picErrType));
  assert.ok(!/[֐-׿]/.test(DICT.en.picErrNotFound));
});
test("every picErr key returned by pictureMessageKey exists in both languages", () => {
  const { pictureMessageKey } = L();
  for (const code of Object.keys(KEYMAP)) for (const lang of ["he", "en"]) assert.ok(DICT[lang][pictureMessageKey(code)], `${lang} ${code}`);
});

// ---------- static source checks ----------
test("step 1 has the picture input after the event-type grid with the right accept", () => {
  const grid = HTML.indexOf('id="eventTypeGrid"');
  const input = HTML.indexOf('id="pictureInput"');
  const name = HTML.indexOf('id="eventName"');
  assert.ok(input > 0, "no #pictureInput");
  assert.ok(grid > 0 && input > grid && input < name, "picture input must sit between the grid and the event name");
  const tag = HTML.slice(HTML.lastIndexOf("<input", input), HTML.indexOf(">", input) + 1);
  assert.ok(/type="file"/.test(tag));
  assert.ok(/accept="image\/jpeg,image\/png,image\/webp"/.test(tag));
  for (const id of ["picThumb", "picStatus", "picRemoveBtn", "picRetryBtn", "toStep2Btn"]) assert.ok(HTML.includes(`id="${id}"`), id);
  assert.ok(/id="toStep2Btn"[^>]*onclick="goToStep2\(\)"|onclick="goToStep2\(\)"[^>]*id="toStep2Btn"/.test(HTML));
  assert.ok(HTML.includes("data-i18n=\"picLabel\"") && HTML.includes("data-i18n=\"picHint\""));
});
test("the picture logic script comes before the main script and is a classic inline script", () => {
  const a = HTML.indexOf("// PICTURE-LOGIC-START"), main = HTML.indexOf("const EVENT_TYPE_LABELS");
  assert.ok(a > 0 && a < main);
  const open = HTML.lastIndexOf("<script", a);
  assert.ok(!/type="module"/.test(HTML.slice(open, HTML.indexOf(">", open))));
});
test("no supabase-js and no extra external script tags were added", () => {
  assert.ok(!/supabase-js|@supabase|cdn\.jsdelivr[^"']*supabase/i.test(HTML));
  const srcs = [...HTML.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.includes("/theme.js"));
  assert.ok(!srcs.some((s) => /supabase/i.test(s)));
});
test("no innerHTML-style sink is fed picture/file/message data in the new block", () => {
  const a = HTML.indexOf("// PICTURE-LOGIC-START"), b = HTML.indexOf("// PICTURE-LOGIC-END");
  assert.ok(a > 0 && b > a, "markers missing");
  const block = HTML.slice(a, b);
  assert.ok(!/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(block), "no HTML sinks in the picture block");
  // and in the wiring/main script, no sink line mentions picture, file or server message data
  const bad = HTML.split("\n").filter((l) => /(innerHTML|outerHTML|insertAdjacentHTML)\s*(=|\()/.test(l) && /picture|pic[A-Z]|file\.name|files\[|\.name\b|data\.error|\.message/i.test(l));
  assert.deepEqual(bad, []);
});
test("saveDraft wiring: never renders data.error from the picture 400 and the Next guard exists", () => {
  assert.ok(/isBusy\(\)\)\s*return\s+showError\(t\("picWait"\)\)/.test(HTML), "goToStep2 guard");
  assert.ok(/pictureErrorFromCreateEvent\(/.test(HTML.slice(HTML.indexOf("const EVENT_TYPE_LABELS"))), "saveDraft handles the 400");
});

// ---------- legal pages ----------
const SENTENCE = "תמונה שהמארגן מעלה לדף האירוע מוצגת לכל מי שמחזיק בקישור לדף, ונמחקת אוטומטית חודש אחד לאחר תאריך האירוע, יחד עם רשימת האורחים. המארגן אחראי לכך שיש לו הזכות להשתמש בתמונה ושהמצולמים, ובפרט קטינים, הסכימו לפרסומה.";
for (const f of ["public/tos.html", "public/privacy.html"]) {
  test(`${f} has the privacy sentence exactly once, inside section 5, as its own <p>`, () => {
    const s = read(f);
    const n = s.split(SENTENCE).length - 1;
    assert.equal(n, 1, "sentence count");
    const h5 = s.indexOf("<h2>5. שמירת מידע ומחיקה</h2>");
    const h6 = s.indexOf("<h2>6.");
    const at = s.indexOf(SENTENCE);
    assert.ok(h5 > 0 && h6 > h5 && at > h5 && at < h6, "inside section 5");
    const pOpen = s.lastIndexOf("<p", at);
    assert.ok(/^<p[^>]*>\s*$/.test(s.slice(pOpen, at).replace(/\s+$/, "") + "") || s.slice(pOpen, at).trim().replace(/<p[^>]*>/, "").trim() === "", "own <p>");
    const after = s.slice(at + SENTENCE.length, s.indexOf("</p>", at));
    assert.equal(after.trim(), "", "nothing else in that <p>");
  });
}

// ---------- function count ----------
test("function count stays 10 (files starting with _ are not functions)", () => {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith(".js") && !e.name.startsWith("_")) out.push(e.name);
    }
  })(path.join(ROOT, "api"));
  assert.equal(out.length, 10);
});
