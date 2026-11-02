"use strict";
// Item 10: after PayPal approval the buyer sees "confirming", the pay buttons are locked, and a
// second payment cannot be started by accident. Runs the real pay script of register.html and
// dashboard.html in node:vm against stubs. No dependencies, no network, no side effects: the vm
// has no real fetch, so a missing mock fails the test instead of reaching a server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const SLUG = "bm-test-2027";

// Every inline <script> without src, in page order.
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function payScript(page) {
  const marker = page === "register" ? "initPayPalButtons" : "initDashPayPal";
  const found = inlineScripts(read(`public/${page}.html`)).filter((s) => s.includes(marker));
  assert.equal(found.length, 1, `${page}: exactly one inline script holds ${marker}`);
  return found[0];
}

function makeElement(tag) {
  const classes = new Set();
  let text = "";
  const el = {
    tag: tag || "div",
    style: {},
    value: "",
    checked: false,
    disabled: false,
    innerHTML: "",
    className: "",
    href: "",
    children: [],
    dataset: {},
    appendChild(c) { el.children.push(c); return c; },
    setAttribute() {},
    scrollIntoView() {},
    addEventListener() {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => { if (classes.has(c)) classes.delete(c); else classes.add(c); },
    },
  };
  // Like the DOM, setting textContent drops the children.
  Object.defineProperty(el, "textContent", {
    configurable: true,
    get: () => text,
    set: (v) => { text = v; el.children = []; },
  });
  return el;
}

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const tick = () => new Promise((r) => setImmediate(r));

// Builds a fresh context with the pay script of `page` loaded.
function load(page) {
  const elements = {};
  const timers = [];
  const listeners = {};
  const store = new Map();
  const calls = [];
  const capture = deferred();

  const ctx = {
    location: { search: "", pathname: page === "dashboard" ? `/dashboard/${SLUG}` : "/register.html", href: "" },
    t: (k) => k,
    crypto: { randomUUID: () => "test-checkout" },
    URLSearchParams,
    alert() {},
    confirm: () => true,
    console: { log() {}, error() {}, warn() {} },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    setTimeout: (fn, delay) => { const rec = { fn, delay, cleared: false }; timers.push(rec); return rec; },
    clearTimeout: (rec) => { if (rec) rec.cleared = true; },
    addEventListener: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener: (name, fn) => { listeners[name] = (listeners[name] || []).filter((f) => f !== fn); },
    scrollTo() {},
    document: {
      getElementById: (id) => (elements[id] = elements[id] || makeElement()),
      querySelectorAll: () => [],
      querySelector: () => makeElement(),
      createElement: (tag) => makeElement(tag),
      head: { appendChild() {} },
    },
    // Because paypal is defined, the SDK loader and /api/paypal-config are never used.
    paypal: {
      Buttons(cfg) { ctx.cfg = cfg; return { render: () => Promise.resolve() }; },
    },
    fetch: async (url, opts) => {
      calls.push({ url: String(url), opts });
      if (url === "/api/paypal-capture?pending=1") return reply(200, {});
      if (url === "/api/create-event") return reply(200, { slug: SLUG });
      if (url === "/api/paypal-create-order") return reply(200, { id: "ORDER123" });
      if (url === "/api/paypal-capture") return capture.promise;
      throw new Error("unexpected fetch in test: " + url);
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(payScript(page), ctx, { filename: `${page}.html` });

  const api = {
    ctx, elements, timers, listeners, store, calls, capture,
    get: (expr) => vm.runInContext(expr, ctx),
    captureCalls: () => calls.filter((c) => c.url === "/api/paypal-capture"),
    createOrderCalls: () => calls.filter((c) => c.url === "/api/paypal-create-order"),
    el: (id) => ctx.document.getElementById(id),
    statusId: page === "register" ? "payStatus" : "dashPayStatus",
    boxId: page === "register" ? "paypal-button-container" : "dash-paypal",
  };
  return api;
}

// Brings the page to the point where the PayPal buttons exist and returns the config.
async function start(page) {
  const h = load(page);
  if (page === "register") {
    h.el("customerName").value = "Test Person";
    h.el("customerEmail").value = "buyer@example.invalid";
    h.el("customerPhone").value = "";
    h.el("tosCheck").checked = true;
    h.get("goToStep3()");
    await tick();
    await tick();
  } else {
    await h.get("initDashPayPal()");
  }
  assert.ok(h.ctx.cfg, `${page}: paypal.Buttons was configured`);
  return h;
}

// Starts approval and waits until the capture fetch is pending.
async function approve(h) {
  const done = h.ctx.cfg.onApprove({ orderID: "TESTORDER1" });
  await tick();
  return { done }; // wrapped: returning the promise itself would make the caller wait for it
}

const status = (h) => h.el(h.statusId);
const box = (h) => h.el(h.boxId);
const waLink = (h) => status(h).children.find((c) => c.tag === "a");

for (const page of ["register", "dashboard"]) {
  test(`${page}: while the capture is in flight the status shows payConfirming, the container is pay-busy, and createOrder is refused without fetching`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    assert.equal(h.get("captureInFlight"), true);
    assert.equal(status(h).textContent, "payConfirming");
    assert.match(status(h).className, /\bshow\b/);
    assert.equal(box(h).classList.contains("pay-busy"), true);
    assert.equal(status(h).children.some((c) => c.className === "spinner"), true);
    assert.equal((h.listeners.beforeunload || []).length, 1, "beforeunload guard is on while waiting");
    assert.equal(h.captureCalls().length, 1);
    if (page === "register") assert.equal(h.el("step3BackBtn").disabled, true);

    const before = h.calls.length;
    await assert.rejects(() => h.ctx.cfg.createOrder());
    assert.equal(h.calls.length, before, "createOrder made no fetch while the capture is in flight");
    assert.equal(h.createOrderCalls().length, 0);

    h.capture.resolve(reply(500, {}));
    await done;
  });

  test(`${page}: after 10 seconds without an answer the status switches to paySlow`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    const slow = h.timers.find((x) => x.delay === 10000);
    assert.ok(slow, "a 10 second timer was set");
    slow.fn();
    assert.equal(status(h).textContent, "paySlow");
    assert.match(status(h).className, /\bwarn\b/);
    assert.equal(box(h).classList.contains("pay-busy"), true);
    assert.equal(h.get("captureInFlight"), true);
    assert.equal(h.captureCalls().length, 1, "the capture fetch is not repeated or aborted by the timer");
    h.capture.resolve(reply(500, {}));
    await done;
  });

  test(`${page}: 200 with a slug: status payConfirmed, beforeunload listener removed, redirect to /success?slug=${SLUG}, slow timer cleared`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    h.capture.resolve(reply(200, { slug: SLUG }));
    await done;
    assert.equal(status(h).textContent, "payConfirmed");
    assert.match(status(h).className, /\bok\b/);
    assert.equal((h.listeners.beforeunload || []).length, 0);
    assert.equal(h.ctx.location.href, `/success?slug=${SLUG}`);
    assert.equal(h.timers.find((x) => x.delay === 10000).cleared, true);
    assert.equal(h.get("captureInFlight"), true, "stays locked while the browser leaves");
    const marker = JSON.parse(h.store.get("rsvp_paid"));
    assert.equal(marker.slug, SLUG, "the rsvp_paid marker holds that slug");
    assert.ok(Math.abs(Date.now() - marker.t) < 60000);
  });

  test(`${page}: 400: pay-busy removed, createOrder works again (returns ORDER123), no redirect, status payNotCompleted`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    h.capture.resolve(reply(400, { error: "not captured" }));
    await done;
    assert.equal(status(h).textContent, "payNotCompleted");
    assert.equal(box(h).classList.contains("pay-busy"), false);
    assert.equal(h.get("captureInFlight"), false);
    assert.equal(h.ctx.location.href, "");
    assert.equal((h.listeners.beforeunload || []).length, 0);
    assert.equal(h.store.has("rsvp_paid"), false, "no marker after a 400");
    assert.equal(await h.ctx.cfg.createOrder(), "ORDER123");
    if (page === "register") assert.equal(h.el("step3BackBtn").disabled, false);
  });

  const reasonSpans = (h) => status(h).children.filter((c) => c.className === "pay-reason");

  test(`${page}: 400 shows the server reason`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    h.capture.resolve(reply(400, { error: "לא ניתן לבחור תאריך שעבר" }));
    await done;
    assert.equal(status(h).textContent, "payNotCompleted");
    const spans = reasonSpans(h);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].tag, "span");
    assert.equal(spans[0].textContent, "לא ניתן לבחור תאריך שעבר");
    assert.equal(status(h).innerHTML, "");
    assert.equal(h.get("captureInFlight"), false);
  });

  test(`${page}: 400 with the generic or unusable error shows no reason`, async () => {
    for (const body of [{ error: "התשלום לא הושלם" }, {}, { error: { x: 1 } }, { error: "   " }]) {
      const h = await start(page);
      const { done } = await approve(h);
      h.capture.resolve(reply(400, body));
      await done;
      assert.equal(status(h).textContent, "payNotCompleted", JSON.stringify(body));
      assert.equal(reasonSpans(h).length, 0, JSON.stringify(body));
    }
  });

  test(`${page}: 400 reason is text only`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    const evil = "<img src=x onerror=alert(1)>";
    h.capture.resolve(reply(400, { error: evil }));
    await done;
    const spans = reasonSpans(h);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].textContent, evil);
    assert.equal(spans[0].innerHTML, "");
    assert.equal(status(h).innerHTML, "");
  });

  test(`${page}: J2-07 unknown state follows the language switch`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    h.capture.resolve(reply(500, {}));
    await done;
    assert.match(status(h).textContent, /^payUnknown TESTORDER1$/);
    h.ctx.t = (k) => "EN:" + k;
    assert.ok((h.listeners.langchange || []).length >= 1, "the page listens for langchange");
    for (const fn of h.listeners.langchange) fn();
    assert.equal(status(h).textContent, "EN:payUnknown TESTORDER1");
    const a = waLink(h);
    assert.ok(a, "WhatsApp link present");
    assert.equal(a.textContent, "EN:waSend");
    assert.ok(a.href.endsWith(encodeURIComponent("EN:waPaidNoConfirm TESTORDER1")));
    assert.equal(h.get("captureInFlight"), true);
    assert.equal(h.captureCalls().length, 1);
    assert.equal(h.createOrderCalls().length, 0);
  });

  test(`${page}: J2-07 confirming state follows the language switch`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    h.ctx.t = (k) => "EN:" + k;
    for (const fn of h.listeners.langchange || []) fn();
    assert.equal(status(h).textContent, "EN:payConfirming");
    assert.equal(box(h).classList.contains("pay-busy"), true);
    assert.equal(h.captureCalls().length, 1, "the capture is not repeated");
    h.capture.resolve(reply(500, {}));
    await done;
  });

  test(`${page}: langchange before any payment leaves the status empty`, async () => {
    const h = await start(page);
    for (const fn of h.listeners.langchange || []) fn();
    assert.equal(status(h).textContent, "");
    assert.equal(status(h).children.length, 0);
    assert.equal(h.calls.filter((c) => c.url === "/api/paypal-capture").length, 0);
  });

  // The same outcome for every answer that does not prove "nothing was captured".
  const unknownCases = [
    ["500 keeps the buttons disabled and shows payUnknown with the order id and a wa.me link, no redirect", (h) => h.capture.resolve(reply(500, { error: "boom" }))],
    ["a rejected capture fetch behaves like 500", (h) => h.capture.reject(new Error("network down"))],
    ["404 after capture behaves like 500", (h) => h.capture.resolve(reply(404, { error: "gone" }))],
    ["a response whose json() rejects behaves like 500", (h) => h.capture.resolve({ status: 502, ok: false, json: async () => { throw new Error("not json"); } })],
    ["200 without a slug behaves like 500", (h) => h.capture.resolve(reply(200, {}))],
  ];
  for (const [title, answer] of unknownCases) {
    test(`${page}: ${title}`, async () => {
      const h = await start(page);
      const { done } = await approve(h);
      answer(h);
      await done;
      assert.equal(h.get("captureInFlight"), true, "buttons stay disabled");
      assert.match(status(h).textContent, /^payUnknown TESTORDER1$/);
      assert.match(status(h).className, /\bwarn\b/);
      assert.equal(box(h).classList.contains("pay-busy"), true);
      const a = waLink(h);
      assert.ok(a, "WhatsApp link present");
      assert.ok(a.href.startsWith("https://wa.me/972546787932?text="));
      assert.ok(a.href.endsWith(encodeURIComponent("waPaidNoConfirm TESTORDER1")));
      assert.equal(a.target, "_blank");
      assert.equal(a.rel, "noopener");
      assert.equal(a.textContent, "waSend");
      assert.equal(h.ctx.location.href, "");
      assert.equal((h.listeners.beforeunload || []).length, 0);
      assert.equal(h.store.has("rsvp_paid"), false);
      await assert.rejects(() => h.ctx.cfg.createOrder());
      assert.equal(h.createOrderCalls().length, 0);
    });
  }

  // onError is the PayPal SDK's error callback. During a capture it must stay silent: the createOrder
  // guard throws on purpose, and that must not show "couldn't load the payment button".
  const errId = page === "register" ? "checkoutError" : "dashPayError";
  const errKey = page === "register" ? "errPaypalPrefix" : "payBlocked";

  test(`${page}: outside a capture, onError shows the error message (control for the in-flight guard)`, async () => {
    const h = await start(page);
    const logged = [];
    h.ctx.console.error = (...a) => { logged.push(a); };
    h.ctx.cfg.onError(new Error("x"));
    assert.equal(h.el(errId).style.display, "block");
    assert.ok(h.el(errId).textContent.includes(errKey));
    if (page === "register") assert.equal(logged.length, 1, "register logs the PayPal error");
  });

  test(`${page}: onError while a capture is in flight shows no error message and logs nothing`, async () => {
    const h = await start(page);
    const logged = [];
    h.ctx.console.error = (...a) => { logged.push(a); };
    h.ctx.console.log = (...a) => { logged.push(a); };
    h.ctx.console.warn = (...a) => { logged.push(a); };
    const { done } = await approve(h);
    assert.equal(h.get("captureInFlight"), true);

    h.ctx.cfg.onError(new Error("x"));
    assert.notEqual(h.el(errId).style.display, "block", "no error box right after the SDK reports an error");
    assert.ok(!h.el(errId).textContent.includes(errKey));

    // The realistic order: the SDK's second click is refused by createOrder, then it calls onError.
    await assert.rejects(() => h.ctx.cfg.createOrder());
    h.ctx.cfg.onError(new Error("In-flight"));
    h.ctx.cfg.onError("a string error");
    assert.notEqual(h.el(errId).style.display, "block", "still no error box after the createOrder refusal");
    assert.ok(!h.el(errId).textContent.includes(errKey));
    assert.equal(logged.length, 0, "nothing is logged while the capture is in flight");
    assert.equal(h.get("captureInFlight"), true);
    assert.equal(h.captureCalls().length, 1);

    h.capture.resolve(reply(500, {}));
    await done;
  });

  test(`${page}: a throwing status box does not stop the capture fetch`, async () => {
    const h = await start(page);
    const st = status(h);
    Object.defineProperty(st, "textContent", { configurable: true, get: () => "", set: () => { throw new Error("ui broke"); } });
    box(h).classList.add = () => { throw new Error("ui broke"); };
    const { done } = await approve(h);
    assert.equal(h.captureCalls().length, 1, "capture was sent although the UI code threw");
    h.capture.resolve(reply(200, { slug: SLUG }));
    await done;
    assert.equal(h.ctx.location.href, `/success?slug=${SLUG}`);
  });

  test(`${page}: the capture request is unchanged`, async () => {
    const h = await start(page);
    const { done } = await approve(h);
    const [c] = h.captureCalls();
    assert.equal(c.url, "/api/paypal-capture");
    assert.equal(c.opts.method, "POST");
    assert.deepEqual({ ...c.opts.headers }, { "Content-Type": "application/json" });
    const body = JSON.parse(c.opts.body);
    if (page === "register") {
      assert.equal(body.orderID, "TESTORDER1");
      assert.equal(body.checkoutId, "test-checkout");
      assert.equal(body.slug, SLUG);
      assert.equal(body.customer_email, "buyer@example.invalid");
      assert.equal(body.customer_name, "Test Person");
    } else {
      assert.deepEqual(body, { orderID: "TESTORDER1", slug: SLUG });
    }
    assert.equal(c.opts.signal, undefined, "no abort signal on the capture");
    h.capture.resolve(reply(500, {}));
    await done;
  });
}

test("register: preview shows the Hebrew date quotes once", async () => {
  const h = await start("register");
  h.get(`formData.hebrew_date = ${JSON.stringify('כ"ח בסיוון תשפ"ו')}; formData.gregorian_date = "2027-01-15";`);
  h.get("renderPreview()");
  const html = h.el("previewCard").innerHTML;
  assert.ok(html.includes("כ&quot;ח בסיוון תשפ&quot;ו · 15 בינואר 2027"), "the date line is escaped exactly once");
  assert.ok(!html.includes("&amp;quot;"), "no double escaping");
});

test("static: neither pay script uses AbortController", () => {
  for (const page of ["register", "dashboard"]) {
    assert.ok(!/AbortController/.test(payScript(page)), `${page}: pay code must not abort the capture`);
  }
});

test("static: register.html and dashboard.html each contain exactly one paypal.Buttons( call", () => {
  for (const page of ["register", "dashboard"]) {
    const n = read(`public/${page}.html`).split("paypal.Buttons(").length - 1;
    assert.equal(n, 1, `${page}: paypal.Buttons( count`);
  }
});

test("static: register.html, dashboard.html and success.html all use the marker key rsvp_paid", () => {
  for (const page of ["register", "dashboard", "success"]) {
    assert.ok(read(`public/${page}.html`).includes("rsvp_paid"), `${page}: rsvp_paid`);
  }
});

test("the capture fetch block is byte-identical to release 59e4ea4", () => {
  const block = (pad, body) => [
    `${pad}res = await fetch("/api/paypal-capture", {`,
    `${pad}  method: "POST",`,
    `${pad}  headers: { "Content-Type": "application/json" },`,
    `${pad}  body: JSON.stringify(${body}),`,
    `${pad}});`,
  ].join("\n");
  const register = block(" ".repeat(12), "{ orderID: data.orderID, checkoutId, slug: draftSlug, ...formData }");
  const dashboard = block(" ".repeat(14), "{ orderID: data.orderID, slug }");
  assert.ok(payScript("register").includes(register), "register.html: the capture fetch block changed");
  assert.ok(payScript("dashboard").includes(dashboard), "dashboard.html: the capture fetch block changed");
  assert.equal(payScript("register").split('fetch("/api/paypal-capture"').length - 1, 1, "register.html: one capture fetch");
  assert.equal(payScript("dashboard").split('fetch("/api/paypal-capture"').length - 1, 1, "dashboard.html: one capture fetch");
});
