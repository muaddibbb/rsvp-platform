"use strict";
// J-01: hostile customer text must not reach /admin as markup. Runs the real inline script of
// public/admin.html in node:vm (no DOM, no network) and inspects the HTML string that is assigned to
// innerHTML. Every tag in that string must be one the page itself writes, with only harmless attribute
// names; no on*= handler, no data-driven tag.
const fetchCalls = [];
global.fetch = async (...args) => { fetchCalls.push(args); throw new Error("network is blocked in tests"); };

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HTML = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
const scripts = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 1);
const CODE = scripts[0];

const HOSTILE = [
  '"><img src=x onerror=alert(1)>',
  "');alert(1)//",
  "</script><script>alert(1)</script>",
  "<svg/onload=alert(1)>",
  "' onmouseover='alert(1)",
  '" autofocus onfocus="alert(1)',
];

function makeCtx(events, opts = {}) {
  const els = {};
  const getEl = (id) => (els[id] = els[id] || { textContent: "", innerHTML: "", value: "", style: {}, dataset: {} });
  const requests = [];
  const ctx = vm.createContext({
    window: { location: { origin: "https://example.test" } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: getEl, querySelectorAll: () => [] },
    alert() {}, confirm: () => true, console,
    fetch: async (url, init = {}) => {
      const method = init.method || "GET";
      requests.push({ url, method, body: init.body });
      if (url === "/api/admin-events" && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ events, abandonedLast30Days: 0 }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  new vm.Script(CODE, { filename: "admin.html#inline" }).runInContext(ctx);
  return { ctx, getEl, requests };
}

const ALLOWED_TAGS = new Set(["tr", "td", "strong", "span", "br", "a", "button"]);
const ALLOWED_ATTRS = new Set(["class", "style", "data-pass", "href", "target", "rel", "data-act", "data-slug", "data-inactive", "title"]);

// Returns the list of problems found in the generated markup (empty = safe).
function markupProblems(html) {
  const problems = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*\/?>/g;
  const stripped = html.replace(tagRe, (all, name, attrs) => {
    if (!ALLOWED_TAGS.has(name.toLowerCase())) problems.push("tag " + name);
    for (const a of attrs.matchAll(/\s+([a-zA-Z-]+)="/g)) {
      if (!ALLOWED_ATTRS.has(a[1])) problems.push("attr " + a[1]);
    }
    return "";
  });
  // anything left that still looks like a tag or a raw quote-break was not matched by the strict grammar
  if (/[<>]/.test(stripped)) problems.push("stray angle bracket: " + stripped.match(/.{0,20}[<>].{0,20}/)[0]);
  return problems;
}

function hostileEvent(payload, i) {
  return {
    slug: "ok-slug-" + i, event_name: payload, event_type: payload, gregorian_date: null, active: true,
    rsvp_count: 0, final_responses: null, final_guests: null, customer_name: payload,
    customer_email: payload, dashboard_password: payload, paid_at: "2026-09-01T10:00:00Z",
  };
}

test("hostile text in name, type, customer, e-mail and password never becomes markup", async () => {
  const events = HOSTILE.map(hostileEvent);
  const h = makeCtx(events);
  await h.ctx.attemptLoad();
  const html = h.getEl("eventsBody").innerHTML;
  assert.deepEqual(markupProblems(html), []);
  assert.ok(!/<img|<svg|<script|<\/script/i.test(html));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "text is kept, escaped");
  assert.ok(html.includes("&quot;&gt;&lt;img"), "quote break is escaped");
  assert.ok(html.includes("&#39;);alert(1)//"), "single quote is escaped");
});

test("a hostile slug is escaped in text, attributes and links", async () => {
  const events = HOSTILE.map((p, i) => ({ ...hostileEvent("x", i), slug: p }));
  const h = makeCtx(events);
  await h.ctx.attemptLoad();
  const html = h.getEl("eventsBody").innerHTML;
  assert.deepEqual(markupProblems(html), []);
  assert.ok(!/<img|<svg|<script/i.test(html));
  for (const m of html.matchAll(/href="([^"]*)"/g)) assert.ok(!/[<>'" ]/.test(m[1]), "href holds no raw metacharacter: " + m[1]);
});

test("no inline event handler is generated and no data is placed in an onclick", async () => {
  const h = makeCtx(HOSTILE.map(hostileEvent));
  await h.ctx.attemptLoad();
  const html = h.getEl("eventsBody").innerHTML;
  // inside real tags (escaped text may still read "onerror=", it is only text)
  // (values inside quoted attributes are inert text too, so they are blanked first)
  for (const tag of html.match(/<[^>]*>/g)) assert.ok(!/\son[a-z]+\s*=/i.test(tag.replace(/="[^"]*"/g, '=""')), tag);
  assert.ok(!html.includes("onclick"));
  assert.equal((html.match(/data-act="/g) || []).length, HOSTILE.length * 4);
});

test("the page script has no inline onclick built from data", () => {
  // static handlers (login, logout, ...) have fixed arguments; the row template has none at all
  const tpl = CODE.slice(CODE.indexOf("function renderTable"), CODE.indexOf("function rowAction"));
  assert.ok(!tpl.includes("onclick"));
});

test("a refunded hostile event: badge, unmark link and receipt number title stay escaped", async () => {
  const events = HOSTILE.map((p, i) => ({ ...hostileEvent(p, i), refunded_at: "2026-10-01T00:00:00Z", receipt_number: i + 1 }));
  const h = makeCtx(events);
  await h.ctx.attemptLoad();
  const html = h.getEl("eventsBody").innerHTML;
  assert.deepEqual(markupProblems(html), []);
  assert.equal((html.match(/data-act="unrefund"/g) || []).length, HOSTILE.length);
  assert.ok(html.includes("זוכה"));
  assert.ok(html.includes('title="קבלה מס׳ 000001"'));
});

test("rowAction reads the slug from dataset and calls the same endpoints", async () => {
  const h = makeCtx([hostileEvent("Name", 1)]);
  await h.ctx.attemptLoad();
  const hostileSlug = "a'b\"c&d";
  await h.ctx.rowAction({ dataset: { act: "delete", slug: hostileSlug } });
  assert.ok(h.requests.some((r) => r.method === "DELETE" && r.url === "/api/admin-events?slug=" + encodeURIComponent(hostileSlug)));
  await h.ctx.rowAction({ dataset: { act: "toggle", slug: "ok-slug-1", inactive: "0" } });
  const patch = h.requests.find((r) => r.method === "PATCH");
  assert.ok(patch && JSON.parse(patch.body).active === false);
  await h.ctx.rowAction({ dataset: { act: "bogus", slug: "x" } });
});

test("esc covers the HTML metacharacters and null", () => {
  const h = makeCtx([]);
  assert.equal(h.ctx.esc(`<>&"'\``), "&lt;&gt;&amp;&quot;&#39;&#96;");
  assert.equal(h.ctx.esc(null), "");
  assert.equal(h.ctx.esc(undefined), "");
  assert.equal(h.ctx.esc(7), "7");
});

test("admin-xss tests made no network call", () => {
  assert.equal(fetchCalls.length, 0);
});
