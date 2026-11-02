"use strict";
// Proves the Super Admin page (public/admin.html) flags finished events: the Israel-time "today" rule
// (exact at the winter and summer midnight edges, independent of the machine's TZ), the "הסתיים · Ended"
// badge in the date cell, the paused state kept separate, and the stats (active not-ended events,
// total replies, revenue) after load, toggle and delete. Runs the real inline script of admin.html in
// node:vm against stubs: no DOM, no network, no real fetch.
// Pin a zone that is not Israel before any Date is used, so a "today" that follows the browser's zone
// instead of Asia/Jerusalem fails in the default run, whatever TZ the machine or the caller has.
process.env.TZ = "America/Los_Angeles";
const fetchCalls = [];
global.fetch = async (...args) => { fetchCalls.push(args); throw new Error("network is blocked in tests"); };

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "public", "admin.html"), "utf8");

const BADGE = '<span class="badge-ended">הסתיים · Ended</span>';
const NOW = Date.parse("2026-11-02T10:00:00Z"); // 2026-11-02 in Israel

function pageScript() {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const found = [];
  let m;
  while ((m = re.exec(HTML))) found.push(m[1]);
  assert.equal(found.length, 1, "admin.html has exactly one inline script");
  assert.ok(found[0].includes("function israelToday"), "the inline script holds israelToday");
  return found[0];
}
const CODE = pageScript();

function fixture() {
  const e = (slug, gregorian_date, active, rsvp_count, final_responses, final_guests) => ({
    slug, event_name: "Event " + slug, event_type: "bar_mitzvah", gregorian_date, active, rsvp_count,
    final_responses, final_guests, customer_name: "Fake Customer", customer_email: slug + "@example.test",
    paid_at: "2026-09-01T10:00:00Z", // no password column: the page falls back to a dash, nothing here needs one
  });
  return [
    e("past-active",   "2026-10-08", true,  12, null, null),
    e("past-paused",   "2026-10-20", false, 4,  null, null),
    e("past-closed",   "2026-09-16", false, 0,  40,   95),
    e("today-active",  "2026-11-02", true,  3,  null, null),
    e("future-active", "2026-12-01", true,  5,  null, null),
    e("future-paused", "2026-12-15", false, 2,  null, null),
  ];
}

// A fresh vm context with the page script loaded. The script declares top-level const/let, so each
// test group gets its own context.
function makeCtx(events = fixture(), opts = {}) {
  const els = {};
  const getEl = (id) => (els[id] = els[id] || { textContent: "", innerHTML: "", value: "", style: {}, dataset: {} });
  const requests = [];
  const ctx = vm.createContext({
    window: { location: { origin: "https://example.test" } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: getEl, querySelectorAll: () => [] },
    alert() {},
    confirm: () => true,
    console,
    fetch: async (url, init = {}) => {
      const method = init.method || "GET";
      requests.push({ url, method });
      if (url === "/api/admin-events" && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ events, abandonedLast30Days: 0 }) };
      }
      if (url.startsWith("/api/admin-events?slug=") && method === "PATCH") {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.startsWith("/api/admin-events?slug=") && method === "DELETE" && opts.allowDelete) {
        return { ok: true, status: 200, json: async () => ({}) };
      }
      throw new Error("unexpected fetch " + method + " " + url);
    },
  });
  vm.runInContext("Date.now = () => " + NOW, ctx);
  new vm.Script(CODE, { filename: "admin.html#inline" }).runInContext(ctx);
  return { ctx, getEl, requests, events };
}

function assertOnlyAdminUrls(requests) {
  for (const r of requests) assert.match(r.url, /^\/api\/admin-events(\?slug=[^&]+)?$/);
}

const rowsOf = (h) => h.getEl("eventsBody").innerHTML.split("<tr class=").slice(1);
const rowFor = (h, slug) => {
  const row = rowsOf(h).find((r) => r.includes(`>${slug}</span>`));
  assert.ok(row, "row for " + slug);
  return row;
};
const stat = (h, id) => String(h.getEl(id).textContent);

// ---------- pure rule ----------
{
  const { ctx } = makeCtx();

  test("israelToday: winter, 21:59Z is still 2026-11-02 and 22:00Z is 2026-11-03", () => {
    assert.equal(ctx.israelToday(Date.parse("2026-11-02T21:59:00Z")), "2026-11-02");
    assert.equal(ctx.israelToday(Date.parse("2026-11-02T22:00:00Z")), "2026-11-03");
  });

  test("israelToday: summer, 20:59Z is still 2026-07-15 and 21:00Z is 2026-07-16", () => {
    assert.equal(ctx.israelToday(Date.parse("2026-07-15T20:59:00Z")), "2026-07-15");
    assert.equal(ctx.israelToday(Date.parse("2026-07-15T21:00:00Z")), "2026-07-16");
  });

  test("isEnded: before today is ended, today and the future are not", () => {
    assert.equal(ctx.isEnded({ gregorian_date: "2026-11-01" }, "2026-11-02"), true);
    assert.equal(ctx.isEnded({ gregorian_date: "2026-11-02" }, "2026-11-02"), false);
    assert.equal(ctx.isEnded({ gregorian_date: "2026-11-03" }, "2026-11-02"), false);
  });

  test("isEnded: winter midnight edge", () => {
    const e = { gregorian_date: "2026-11-02" };
    assert.equal(ctx.isEnded(e, ctx.israelToday(Date.parse("2026-11-02T21:59:00Z"))), false);
    assert.equal(ctx.isEnded(e, ctx.israelToday(Date.parse("2026-11-02T22:00:00Z"))), true);
  });

  test("isEnded: summer midnight edge", () => {
    const e = { gregorian_date: "2026-07-15" };
    assert.equal(ctx.isEnded(e, ctx.israelToday(Date.parse("2026-07-15T20:59:00Z"))), false);
    assert.equal(ctx.isEnded(e, ctx.israelToday(Date.parse("2026-07-15T21:00:00Z"))), true);
  });

  test("isEnded: missing or malformed dates are never ended", () => {
    assert.equal(ctx.isEnded(undefined, "2026-11-02"), false);
    assert.equal(ctx.isEnded(null, "2026-11-02"), false);
    for (const d of [undefined, null, "", "02/11/2026", "2026-1-5", "2026-11-01T00:00:00Z", 20261101]) {
      assert.equal(ctx.isEnded({ gregorian_date: d }, "2026-11-02"), false, "date " + String(d));
    }
  });

  test("responsesOf: live count wins while replies exist, snapshot after closing", () => {
    assert.equal(ctx.responsesOf({ rsvp_count: 5, final_responses: 40 }), 5);
    assert.equal(ctx.responsesOf({ rsvp_count: 0, final_responses: 40 }), 40);
    assert.equal(ctx.responsesOf({ rsvp_count: 0, final_responses: null }), 0);
    assert.equal(ctx.responsesOf({ final_responses: null }), 0);
  });
}

// ---------- render ----------
{
  const h = makeCtx();
  let loaded;
  const load = () => (loaded = loaded || h.ctx.attemptLoad());

  test("renders one row per returned event", async () => {
    await load();
    assert.equal(rowsOf(h).length, 6);
    assertOnlyAdminUrls(h.requests);
  });

  test("past rows show the Ended badge: past-active, past-paused, past-closed", async () => {
    await load();
    for (const slug of ["past-active", "past-paused", "past-closed"]) {
      assert.ok(rowFor(h, slug).includes(BADGE), slug);
    }
  });

  test("an event dated today shows no Ended badge, and future events show none either", async () => {
    await load();
    for (const slug of ["today-active", "future-active", "future-paused"]) {
      const row = rowFor(h, slug);
      assert.ok(!row.includes("badge-ended"), slug);
      assert.ok(!row.includes("הסתיים"), slug);
    }
  });

  test("an ended and paused event shows both badges (D-1)", async () => {
    await load();
    for (const slug of ["past-paused", "past-closed"]) {
      const row = rowFor(h, slug);
      assert.ok(row.includes("badge-ended"), slug);
      assert.ok(row.includes("badge-inactive"), slug);
      assert.ok(row.includes("מושבת"), slug);
    }
  });

  test("a paused future event keeps its paused state", async () => {
    await load();
    const row = rowFor(h, "future-paused");
    assert.ok(row.startsWith('"inactive">'));
    assert.ok(row.includes("מושבת"));
    assert.ok(!row.includes("הסתיים"));
  });

  test("ended rows are not dimmed and keep every action button", async () => {
    await load();
    const row = rowFor(h, "past-active");
    assert.ok(row.startsWith('"">'));
    for (const fn of ["downloadReceipt", "toggleActive", "deleteEvent"]) assert.ok(row.includes(fn), fn);
  });

  test("the count cell shows the live count, or the snapshot for a closed event", async () => {
    await load();
    for (const e of h.events) {
      const cell = /<td class="rsvp-count"[^>]*>([\s\S]*?)<\/td>/.exec(rowFor(h, e.slug));
      assert.ok(cell, "count cell of " + e.slug);
      const text = cell[1].replace(/<[^>]*>/g, "");
      // The first text segment (before the guests line, if any) must equal the count exactly.
      assert.equal(cell[1].split("<br/>")[0].replace(/<[^>]*>/g, "").trim(), String(h.ctx.responsesOf(e)), `${e.slug}: "${text}"`);
    }
    assert.ok(rowFor(h, "past-closed").includes("95 אורחים"));
  });
}

// ---------- a row without a valid date ----------
{
  const nullDate = {
    slug: "no-date", event_name: null, event_type: "bar_mitzvah", gregorian_date: null, active: true, rsvp_count: 0,
    final_responses: null, final_guests: null, customer_name: "Fake Customer", customer_email: "no-date@example.test",
    paid_at: "2026-09-01T10:00:00Z",
  };
  const h = makeCtx([...fixture(), nullDate]);
  let loaded;
  const load = () => (loaded = loaded || h.ctx.attemptLoad());

  test("a row with a null date and a null name renders: dash in the date cell, no Ended badge", async () => {
    await load();
    assert.equal(rowsOf(h).length, 7);
    const row = rowFor(h, "no-date");
    const dateCell = /<td style="white-space:nowrap">([\s\S]*?)<\/td>/.exec(row);
    assert.ok(dateCell, "date cell of no-date");
    assert.equal(dateCell[1], "—");
    assert.ok(!row.includes("badge-ended"));
    assert.ok(!row.includes("הסתיים"));
    assertOnlyAdminUrls(h.requests);
  });

  test("a row with a null date counts as an active event and adds no replies or Ended state", async () => {
    await load();
    assert.equal(stat(h, "statEvents"), "3");
    assert.equal(stat(h, "statRsvps"), "66");
    assert.equal(stat(h, "statRevenue"), "₪693");
  });
}

// ---------- stats ----------
test("stats after load: events 2, rsvps 66, revenue ₪594", async () => {
  const h = makeCtx();
  await h.ctx.attemptLoad();
  assert.equal(stat(h, "statEvents"), "2");
  assert.equal(stat(h, "statRsvps"), "66");
  assert.equal(stat(h, "statRevenue"), "₪594");
  assertOnlyAdminUrls(h.requests);
});

test("stats after deactivating an active future event: events drops to 1", async () => {
  const h = makeCtx();
  await h.ctx.attemptLoad();
  await h.ctx.toggleActive("future-active", false);
  assert.ok(h.requests.some((r) => r.method === "PATCH" && r.url === "/api/admin-events?slug=future-active"));
  assert.equal(stat(h, "statEvents"), "1");
  assert.equal(stat(h, "statRsvps"), "66");
  assert.equal(stat(h, "statRevenue"), "₪594");
  assert.ok(rowFor(h, "future-active").startsWith('"inactive">'));
  assertOnlyAdminUrls(h.requests);
});

test("stats after deleting an event: counts follow the list", async () => {
  const h = makeCtx(fixture(), { allowDelete: true });
  await h.ctx.attemptLoad();
  await h.ctx.deleteEvent("past-closed", "x");
  assert.ok(h.requests.some((r) => r.method === "DELETE" && r.url === "/api/admin-events?slug=past-closed"));
  assert.equal(stat(h, "statEvents"), "2");
  assert.equal(stat(h, "statRsvps"), "26");
  assert.equal(stat(h, "statRevenue"), "₪495");
  assert.equal(rowsOf(h).length, 5);
  assertOnlyAdminUrls(h.requests);
});

// ---------- static ----------
test("admin.html still has no PAGE_I18N and no data-i18n (D-2: fixed badge text)", () => {
  assert.ok(!HTML.includes("PAGE_I18N"));
  assert.ok(!HTML.includes("data-i18n"));
});

test("admin.html defines .badge-ended and its dark-mode rule, and contains no 149", () => {
  assert.match(HTML, /\.badge-ended \{/);
  assert.match(HTML, /html\.dark \.badge-ended/);
  assert.ok(!HTML.includes("149"));
});

test("admin-ended tests made no network call", () => {
  assert.equal(fetchCalls.length, 0);
});
