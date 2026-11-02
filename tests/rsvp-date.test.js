"use strict";
// The guest page (public/rsvp.html) shows the event date as "15 בינואר 2027" / "January 15, 2027" (Hebrew date
// first when there is one), follows a language switch, never shows "Invalid Date" or a raw ISO date, and gives
// the same text in every time zone. Runs the page's real inline script in node:vm against stubs: no DOM, no
// network, no real fetch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "public", "rsvp.html"), "utf8");

function inlineScripts() {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const found = [];
  let m;
  while ((m = re.exec(HTML))) found.push(m[1]);
  return found;
}
const SCRIPTS = inlineScripts();
const DICT_SRC = SCRIPTS[0];
const MAIN_SRC = SCRIPTS.find((s) => s.includes("function populateEvent"));
assert.ok(DICT_SRC.includes("window.PAGE_I18N"), "the first inline script holds the dictionary");
assert.ok(MAIN_SRC, "an inline script holds populateEvent");

const dictCtx = vm.createContext({ window: {} });
vm.runInContext(DICT_SRC, dictCtx);
const DICT = dictCtx.window.PAGE_I18N;

const REAL = {
  event_name: "Fake Event", event_type: "wedding", hebrew_date: "ו׳ בשבט תשפ״ז", gregorian_date: "2027-01-15",
  event_time: "19:30", location: "Fake Hall", address: "1 Example Street", extra_note: "",
};

const tick = () => new Promise((r) => setImmediate(r));

// Load the page script at /rsvp/<slug>. `event` is what GET /api/event/real-2027 answers.
async function load({ slug = "demo", lang = "he", event = REAL } = {}) {
  const els = {};
  const getEl = (id) => (els[id] = els[id] || {
    style: {}, textContent: "", href: "", value: "", addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, parentElement: {},
  });
  const listeners = {};
  const fetches = [];
  const state = { lang };
  const ctx = vm.createContext({
    window: {
      location: { pathname: "/rsvp/" + slug, search: "" },
      addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    },
    URLSearchParams,
    document: {
      readyState: "complete",
      title: "",
      documentElement: { classList: { add() {} } },
      getElementById: getEl,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
    t: (k) => (DICT[state.lang] || {})[k] || k,
    getLang: () => state.lang,
    fetch: async (url, init = {}) => {
      fetches.push({ url, method: init.method || "GET" });
      if (url === "/api/event/real-2027") return { ok: true, status: 200, json: async () => event };
      throw new Error("unexpected fetch " + url);
    },
    console,
  });
  new vm.Script(MAIN_SRC, { filename: "rsvp.html#inline" }).runInContext(ctx);
  await tick(); await tick();
  return { ctx, state, listeners, fetches, date: () => getEl("detailDate").textContent };
}

test("demo event, Hebrew: 15 בינואר 2027", async () => {
  const h = await load({ slug: "demo", lang: "he" });
  assert.equal(h.date(), "15 בינואר 2027");
});

test("demo event, English: January 15, 2027", async () => {
  const h = await load({ slug: "demo", lang: "en" });
  assert.equal(h.date(), "January 15, 2027");
});

test("real event with a Hebrew date: the Hebrew date first, then the Gregorian one, in both languages", async () => {
  const he = await load({ slug: "real-2027", lang: "he" });
  assert.equal(he.date(), "ו׳ בשבט תשפ״ז · 15 בינואר 2027");
  const en = await load({ slug: "real-2027", lang: "en" });
  assert.equal(en.date(), "ו׳ בשבט תשפ״ז · January 15, 2027");
});

test("a language switch re-renders the date", async () => {
  const h = await load({ slug: "real-2027", lang: "he" });
  assert.equal(h.date(), "ו׳ בשבט תשפ״ז · 15 בינואר 2027");
  h.state.lang = "en";
  assert.ok((h.listeners.langchange || []).length >= 1, "the page listens for langchange");
  for (const fn of h.listeners.langchange) fn();
  assert.equal(h.date(), "ו׳ בשבט תשפ״ז · January 15, 2027");
});

test("a missing or unexpected date never shows Invalid Date", async () => {
  const none = await load({ slug: "real-2027", event: { ...REAL, hebrew_date: "", gregorian_date: null } });
  assert.equal(none.date(), "");
  const odd = await load({ slug: "real-2027", event: { ...REAL, hebrew_date: "", gregorian_date: "15/01/2027" } });
  assert.equal(odd.date(), "15/01/2027");
  assert.ok(!/Invalid Date/.test(none.date() + odd.date()));
});

test("the date text is the same in the earliest and the latest time zone", async () => {
  const realTZ = process.env.TZ;
  try {
    const baseline = (await load({ slug: "demo", lang: "he" })).date();
    assert.equal(baseline, "15 בינואר 2027");
    for (const tz of ["Pacific/Pago_Pago", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, tz, "the zone switch took effect");
      assert.equal((await load({ slug: "demo", lang: "he" })).date(), baseline, tz);
      assert.equal((await load({ slug: "demo", lang: "en" })).date(), "January 15, 2027", tz);
    }
  } finally {
    if (realTZ === undefined) delete process.env.TZ; else process.env.TZ = realTZ;
  }
});

test("demo makes no fetch, a real event makes exactly one GET /api/event/real-2027", async () => {
  const demo = await load({ slug: "demo" });
  assert.equal(demo.fetches.length, 0);
  const real = await load({ slug: "real-2027" });
  assert.deepEqual(real.fetches, [{ url: "/api/event/real-2027", method: "GET" }]);
});

test("rsvp.html no longer joins the raw Gregorian date string", () => {
  assert.ok(!HTML.includes("+ ev.gregorian_date"));
  assert.ok(!HTML.includes(": ev.gregorian_date;"));
});
