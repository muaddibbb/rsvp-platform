"use strict";
// Admin revenue and the refund marker on public/admin.html: revenue = 99 x paid events that are not refunded;
// a refunded row shows the "זוכה" badge and an unmark link; the refund button asks, marks, then downloads the
// credit note. Runs the real inline script in node:vm against stubs: no DOM, no network.
const fetchCalls = [];
global.fetch = async (...args) => { fetchCalls.push(args); throw new Error("network is blocked in tests"); };

const test = require("node:test");
require("./_quiet")(test);   // M-1: keep handler logging off the runner's result pipe
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
const CODE = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];

const ev = (slug, refunded_at) => ({
  slug, event_name: "Event " + slug, event_type: "bar_mitzvah", gregorian_date: "2099-01-01", active: true, rsvp_count: 0,
  final_responses: null, final_guests: null, customer_name: "Fake Customer", customer_email: slug + "@example.test",
  paid_at: "2026-09-01T10:00:00Z", refunded_at,
});

function makeCtx(events, { confirmAnswer = true, patchStatus = 200 } = {}) {
  const els = {};
  const getEl = (id) => (els[id] = els[id] || { textContent: "", innerHTML: "", value: "", style: {}, dataset: {} });
  const requests = [];
  const downloads = [];
  const ctx = vm.createContext({
    window: { location: { origin: "https://example.test" } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: getEl, querySelectorAll: () => [], createElement: () => { const a = { click() { downloads.push(a.download); } }; return a; } },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    alerts: [],
    alert(m) { ctx.alerts.push(m); },
    confirm: () => confirmAnswer,
    console,
    fetch: async (url, init = {}) => {
      const method = init.method || "GET";
      requests.push({ url, method, body: init.body });
      if (url === "/api/admin-events") return { ok: true, status: 200, json: async () => ({ events, abandonedLast30Days: 0 }) };
      if (method === "PATCH") {
        const b = JSON.parse(init.body);
        return { ok: patchStatus === 200, status: patchStatus, json: async () => ({ refunded: b.refunded, refunded_at: b.refunded ? "2026-11-03T08:00:00.000Z" : null }) };
      }
      if (url.startsWith("/api/admin-events?refund=1")) return { ok: true, status: 200, blob: async () => ({}) };
      throw new Error("unexpected fetch " + method + " " + url);
    },
  });
  new vm.Script(CODE).runInContext(ctx);
  return { ctx, getEl, requests, downloads };
}
const revenue = (h) => String(h.getEl("statRevenue").textContent);

test("revenue = 99 x paid events that are not refunded", async () => {
  const h = makeCtx([ev("a", null), ev("b", null), ev("c", "2026-10-01T00:00:00Z"), ev("d", undefined)]);
  await h.ctx.attemptLoad();
  assert.equal(revenue(h), "₪297");
});

test("customer's case: six paid events, none refunded: ₪594; before the migration (no field at all) the same", async () => {
  const six = ["a", "b", "c", "d", "e", "f"];
  const h = makeCtx(six.map((s) => ev(s, null)));
  await h.ctx.attemptLoad();
  assert.equal(revenue(h), "₪594");
  const old = makeCtx(six.map((s) => { const e = ev(s); delete e.refunded_at; return e; }));
  await old.ctx.attemptLoad();
  assert.equal(revenue(old), "₪594");
});

test("the admin price constant equals PRICE_ILS in api/_pay.js and the create-order literal", () => {
  const pay = require("../api/_pay");
  assert.match(HTML, new RegExp(`const PRICE_PER_EVENT = ${pay.PRICE_ILS};`));
  assert.match(fs.readFileSync(path.join(__dirname, "..", "api", "paypal-create-order.js"), "utf8"), new RegExp(`value:\\s*"${pay.PRICE_ILS}\\.00"`));
});

test("a refunded row shows the badge and the unmark link; the others do not", async () => {
  const h = makeCtx([ev("a", null), ev("b", "2026-10-01T00:00:00Z")]);
  await h.ctx.attemptLoad();
  const [, rowA, rowB] = h.getEl("eventsBody").innerHTML.split("<tr class=");
  assert.ok(!rowA.includes("זוכה") && !rowA.includes("unrefund"));
  assert.ok(rowB.includes("זוכה") && rowB.includes('data-act="unrefund"'));
});

test("refund button: asks, marks via PATCH {refunded:true}, then downloads the credit note; revenue drops", async () => {
  const h = makeCtx([ev("a", null), ev("b", null)]);
  await h.ctx.attemptLoad();
  await h.ctx.rowAction({ dataset: { act: "refund", slug: "a" } });
  const patch = h.requests.find((r) => r.method === "PATCH");
  assert.equal(patch.url, "/api/admin-events?slug=a");
  assert.deepEqual(JSON.parse(patch.body), { refunded: true });
  assert.ok(h.requests.some((r) => r.url === "/api/admin-events?refund=1&slug=a"));
  assert.deepEqual(h.downloads, ["זיכוי-a.pdf"]);
  assert.equal(revenue(h), "₪99");
  assert.ok(h.getEl("eventsBody").innerHTML.includes("זוכה"));
});

test("refund button: if the owner declines the question nothing is sent", async () => {
  const h = makeCtx([ev("a", null)], { confirmAnswer: false });
  await h.ctx.attemptLoad();
  const before = h.requests.length;
  await h.ctx.rowAction({ dataset: { act: "refund", slug: "a" } });
  assert.equal(h.requests.length, before);
  assert.equal(revenue(h), "₪99");
});

test("refund button on an already refunded event only downloads the credit note again", async () => {
  const h = makeCtx([ev("a", "2026-10-01T00:00:00Z")]);
  await h.ctx.attemptLoad();
  await h.ctx.rowAction({ dataset: { act: "refund", slug: "a" } });
  assert.ok(!h.requests.some((r) => r.method === "PATCH"));
  assert.deepEqual(h.downloads, ["זיכוי-a.pdf"]);
});

test("unmark link sends {refunded:false} and revenue counts the event again", async () => {
  const h = makeCtx([ev("a", "2026-10-01T00:00:00Z")]);
  await h.ctx.attemptLoad();
  assert.equal(revenue(h), "₪0");
  await h.ctx.rowAction({ dataset: { act: "unrefund", slug: "a" } });
  assert.deepEqual(JSON.parse(h.requests.find((r) => r.method === "PATCH").body), { refunded: false });
  assert.equal(revenue(h), "₪99");
});

test("when the server says 'migration needed' (409) nothing is marked and no credit note is downloaded", async () => {
  const h = makeCtx([ev("a", null)], { patchStatus: 409 });
  await h.ctx.attemptLoad();
  await h.ctx.rowAction({ dataset: { act: "refund", slug: "a" } });
  assert.equal(revenue(h), "₪99");
  assert.deepEqual(h.downloads, []);
  assert.equal(h.ctx.alerts.length, 1);
});

test("admin-refund tests made no network call", () => assert.equal(fetchCalls.length, 0));
