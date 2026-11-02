"use strict";
// Item 14: /success counts a Google Ads sale only when the server confirms the event is paid AND this
// browser tab has just paid. Runs the real <script id="success-logic"> of success.html in node:vm.
// No dependencies, no network, no side effects: the vm gets a mock fetch and a spy gtag, never a
// real fetch. theme.js's t() is deliberately not defined (the script must not depend on it).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "public/success.html"), "utf8");
const m = HTML.match(/<script id="success-logic">([\s\S]*?)<\/script>/);
assert.ok(m, "success.html has <script id=\"success-logic\">");
const SCRIPT = m[1];

const SEND_TO = "AW-18293655759/t6piCIOmuMkcEM-RjJNE";

function reply(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function makeElement() {
  return { style: {}, textContent: "", href: "", onclick: null };
}

// `fetchImpl(url, opts, callIndex)` answers each fetch. `store` is the sessionStorage Map (pre-fill or reuse).
function run({ search = "", store = new Map(), fetchImpl } = {}) {
  const elements = {};
  const fetchCalls = [];
  const gtagCalls = [];
  const timers = [];
  const ctx = {
    location: { search, origin: "https://rsvp.kupernet.com" },
    document: { getElementById: (id) => (elements[id] = elements[id] || makeElement()) },
    URLSearchParams,
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    AbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
    setTimeout: (fn, delay) => { const rec = { fn, delay, cleared: false }; timers.push(rec); return rec; },
    clearTimeout: (rec) => { if (rec) rec.cleared = true; },
    fetch: async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      if (!fetchImpl) throw new Error("unexpected fetch in test: " + url);
      return fetchImpl(String(url), opts, fetchCalls.length - 1);
    },
    gtag: (...args) => { gtagCalls.push(args); },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx, { filename: "success.html" });
  const conversions = () => gtagCalls.filter((c) => c[0] === "event" && c[1] === "conversion");
  const visible = (id) => elements[id] && elements[id].style.display === "block";
  return { ctx, store, elements, fetchCalls, gtagCalls, timers, conversions, visible };
}

const fresh = (slug, ageMs = 0) => JSON.stringify({ slug, t: Date.now() - ageMs });
const paid = (extra) => async () => reply(200, { event_name: "Test Event", ...extra });

test("no slug in the URL: 0 fetches, 0 conversions, notFoundState shown", async () => {
  const r = run({ search: "" });
  await r.ctx.successReady;
  assert.equal(r.fetchCalls.length, 0);
  assert.equal(r.conversions().length, 0);
  assert.equal(r.visible("notFoundState"), true);
  assert.equal(r.visible("successState"), false);
  assert.equal(r.visible("checkingState"), false);
});

test("?slug= (empty): 0 fetches, 0 conversions", async () => {
  const r = run({ search: "?slug=" });
  await r.ctx.successReady;
  assert.equal(r.fetchCalls.length, 0);
  assert.equal(r.conversions().length, 0);
  assert.equal(r.visible("notFoundState"), true);
});

test("made-up slug with a 404: exactly one GET to /api/event/made-up-slug (no body), 0 conversions, successState hidden, notFoundState shown", async () => {
  const store = new Map([["rsvp_paid", fresh("made-up-slug")]]); // even a marker cannot make up for the server
  const r = run({ search: "?slug=made-up-slug", store, fetchImpl: async () => reply(404, { error: "x" }) });
  await r.ctx.successReady;
  assert.equal(r.fetchCalls.length, 1);
  assert.equal(r.fetchCalls[0].url, "/api/event/made-up-slug");
  assert.ok(r.fetchCalls[0].opts.method === undefined || r.fetchCalls[0].opts.method === "GET");
  assert.equal(r.fetchCalls[0].opts.body, undefined);
  assert.equal(r.conversions().length, 0);
  assert.equal(r.visible("successState"), false);
  assert.equal(r.visible("notFoundState"), true);
});

test("several made-up slugs, each 404: 0 conversions", async () => {
  let total = 0;
  for (const slug of ["abc", "bm-2027-xyz", "a", "test-123", "x".repeat(100)]) {
    const r = run({ search: `?slug=${slug}`, fetchImpl: async () => reply(404, {}) });
    await r.ctx.successReady;
    total += r.conversions().length;
    assert.equal(r.visible("successState"), false, slug);
  }
  assert.equal(total, 0);
});

test("malformed slugs (%3Cscript%3E and ../x): 0 fetches, 0 conversions", async () => {
  for (const search of ["?slug=%3Cscript%3E", "?slug=../x", "?slug=UPPER", "?slug=" + "a".repeat(101)]) {
    const r = run({ search });
    await r.ctx.successReady;
    assert.equal(r.fetchCalls.length, 0, search);
    assert.equal(r.conversions().length, 0, search);
    assert.equal(r.visible("notFoundState"), true, search);
  }
});

test("paid event (200) with a fresh marker for the same slug: exactly 1 conversion with send_to AW-18293655759/t6piCIOmuMkcEM-RjJNE, value 99, currency ILS, transaction_id = slug; marker removed afterwards; successState shown with the event name in eventNameLine", async () => {
  const store = new Map([["rsvp_paid", fresh("bm-2027")]]);
  const r = run({ search: "?slug=bm-2027", store, fetchImpl: paid() });
  await r.ctx.successReady;
  const c = r.conversions();
  assert.equal(c.length, 1);
  assert.deepEqual({ ...c[0][2] }, { send_to: SEND_TO, value: 99, currency: "ILS", transaction_id: "bm-2027" });
  assert.equal(store.has("rsvp_paid"), false, "marker removed after the call");
  assert.equal(r.visible("successState"), true);
  assert.equal(r.visible("checkingState"), false);
  assert.equal(r.elements.eventNameLine.textContent, "Test Event");
  assert.equal(r.elements.rsvpLinkBtn.href, "https://rsvp.kupernet.com/rsvp/bm-2027");
  assert.equal(r.elements.dashboardLinkBtn.href, "https://rsvp.kupernet.com/dashboard/bm-2027");
  assert.ok(r.elements.waBtn.href.startsWith("https://wa.me/?text="));
});

test("paid event without a marker, with a marker for another slug, and with a 31-minute-old marker: 0 conversions each, successState still shown", async () => {
  const cases = {
    "no marker": new Map(),
    "other slug": new Map([["rsvp_paid", fresh("someone-else")]]),
    "31 minutes old": new Map([["rsvp_paid", fresh("bm-2027", 31 * 60 * 1000)]]),
    "garbage": new Map([["rsvp_paid", "not json"]]),
    "from the future": new Map([["rsvp_paid", fresh("bm-2027", -10 * 60 * 1000)]]),
  };
  for (const [name, store] of Object.entries(cases)) {
    const r = run({ search: "?slug=bm-2027", store, fetchImpl: paid() });
    await r.ctx.successReady;
    assert.equal(r.conversions().length, 0, name);
    assert.equal(r.visible("successState"), true, name);
  }
});

test("reload with the same storage: 1 conversion in total", async () => {
  const store = new Map([["rsvp_paid", fresh("bm-2027")]]);
  let total = 0;
  for (let i = 0; i < 3; i++) {
    const r = run({ search: "?slug=bm-2027", store, fetchImpl: paid() });
    await r.ctx.successReady;
    total += r.conversions().length;
    assert.equal(r.visible("successState"), true);
  }
  assert.equal(total, 1);
});

test("fetch 500, any other non-200, a rejected fetch, and a 200 with a non-JSON body: 0 conversions, verifyErrorState shown", async () => {
  const answers = {
    "500": async () => reply(500, {}),
    "403": async () => reply(403, {}),
    "502": async () => reply(502, {}),
    "rejected": async () => { throw new Error("network down"); },
    "200 non-JSON": async () => ({ status: 200, ok: true, json: async () => { throw new Error("not json"); } }),
  };
  for (const [name, fetchImpl] of Object.entries(answers)) {
    const store = new Map([["rsvp_paid", fresh("bm-2027")]]);
    const r = run({ search: "?slug=bm-2027", store, fetchImpl });
    await r.ctx.successReady;
    assert.equal(r.conversions().length, 0, name);
    assert.equal(r.visible("verifyErrorState"), true, name);
    assert.equal(r.visible("successState"), false, name);
    assert.equal(store.has("rsvp_paid"), true, name + ": the marker survives so a retry can still count");
  }
});

test("an 8 second abort is wired to the request: the timer aborts the fetch's own signal, verifyErrorState shows, the timer is cleared", async () => {
  let rejectFetch;
  let seenAbortedAtFetch;
  // A hanging GET: it only settles when the test (like a real fetch) sees its signal aborted.
  const r = run({
    search: "?slug=bm-2027",
    fetchImpl: (url, opts) => new Promise((resolve, reject) => { seenAbortedAtFetch = opts.signal.aborted; rejectFetch = reject; }),
  });
  assert.equal(r.fetchCalls.length, 1, "the GET is pending");
  const { opts } = r.fetchCalls[0];
  assert.ok(opts.signal && typeof opts.signal === "object", "the fetch options carry a signal");
  assert.equal(opts.cache, "no-store");
  assert.equal(seenAbortedAtFetch, false, "not aborted when the request starts");
  assert.equal(opts.signal.aborted, false, "still pending, not aborted yet");

  const t = r.timers.find((x) => x.delay === 8000);
  assert.ok(t, "an 8 second abort timer exists");
  assert.equal(t.cleared, false, "still armed while the GET hangs");
  assert.equal(r.visible("verifyErrorState"), false);

  t.fn(); // the 8 seconds pass
  assert.equal(opts.signal.aborted, true, "the timer aborts the signal that the fetch received");
  rejectFetch(new Error("aborted")); // what a real fetch does once its signal is aborted
  await r.ctx.successReady;

  assert.equal(t.cleared, true, "the timer is cleared once the fetch settles");
  assert.equal(r.visible("verifyErrorState"), true);
  assert.equal(r.visible("successState"), false);
  assert.equal(r.conversions().length, 0);
});

test("retry button re-runs the check", async () => {
  const store = new Map([["rsvp_paid", fresh("bm-2027")]]);
  const r = run({
    search: "?slug=bm-2027",
    store,
    fetchImpl: async (url, opts, i) => (i === 0 ? reply(500, {}) : reply(200, { event_name: "Test Event" })),
  });
  await r.ctx.successReady;
  assert.equal(r.visible("verifyErrorState"), true);
  assert.equal(r.conversions().length, 0);
  assert.equal(typeof r.elements.retryBtn.onclick, "function");
  r.elements.retryBtn.onclick();
  await r.ctx.successReady;
  assert.equal(r.fetchCalls.length, 2);
  assert.equal(r.conversions().length, 1);
  assert.equal(r.visible("successState"), true);
});

test("static: success.html has exactly one gtag('event','conversion' call (regex tolerant of spaces), it is inside the success-logic script, and the old text \"התשלום התקבל\" no longer appears in the page markup or dictionaries", () => {
  const re = /gtag\(\s*['"]event['"]\s*,\s*['"]conversion['"]/g;
  assert.equal((HTML.match(re) || []).length, 1, "one conversion call in the page");
  assert.equal((SCRIPT.match(re) || []).length, 1, "and it is inside success-logic");
  assert.ok(!HTML.includes("התשלום התקבל"), "old claim removed");
  assert.ok(!/Payment received/i.test(HTML), "old English claim removed");
  assert.equal((HTML.match(/<script id="success-logic">/g) || []).length, 1);
});
