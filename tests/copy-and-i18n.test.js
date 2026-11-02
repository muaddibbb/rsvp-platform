"use strict";
// Items 8 and 9: one true refund sentence everywhere, WhatsApp links, testimonials, removed claims,
// and every translation key present in both languages. Static: reads public/ as text and evaluates
// the dictionaries in node:vm. No dependencies, no network, no side effects.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
const html = Object.fromEntries(pages.map((f) => [f.replace(/\.html$/, ""), read(`public/${f}`)]));

// The banned-wording scans below ("old guarantee/trial/no-questions" wording and "!!!") cover exactly
// these files and nothing else: the customer-facing pages, plus the customer recovery email that this
// run rewrote. admin.html is left out on purpose: it is the owner's tool, another run edits it, and
// "ניסיון" is also an ordinary Hebrew word ("attempt"). The other emails in api/ are not scanned
// (paypal-capture.js legitimately says "ניסיון תשלום נכשל" in the owner's alert).
const CUSTOMER_PAGES = ["index", "pricing", "register", "dashboard", "success", "refund", "rsvp", "tos", "privacy"];
const CUSTOMER_EMAIL_FILES = ["api/_recovery.js"];
const SCANNED = Object.fromEntries([
  ...CUSTOMER_PAGES.map((p) => [`public/${p}.html`, read(`public/${p}.html`)]),
  ...CUSTOMER_EMAIL_FILES.map((f) => [f, read(f)]),
]);

const REFUND_HE_CORE = "החזר כספי מלא תוך 14 יום מהרכישה, כל עוד לא התקבל אף אישור הגעה והאירוע טרם התקיים.";
const REFUND_EN_CORE = "Full refund within 14 days of purchase, as long as no RSVP has been received and the event hasn't taken place yet.";
const REFUND_HE = "↩️ " + REFUND_HE_CORE;
const REFUND_EN = "↩️ " + REFUND_EN_CORE;
const WA_BASE = "https://wa.me/972546787932";
const WA_QUESTION = "היי, יש לי שאלה על אישורי ההגעה באתר rsvp.kupernet.com";
const TESTIMONIALS = [
  "פשוט, קל לתפעול ובלי לקרוע את הכיס. ממליצה בחום! (נועה נ)",
  "חיפשתי הרבה זמן שירות אישורי הגעה, כשמצאתי את זה המחיר נראה לי קצת מוזר, אבל אני חייב להודות שזה מעולה! ממליץ לכל מי שצריך אישורי הגעה - סופר נוח וזול! (אייל ג)",
];

// ── dictionary loading ──
function themeDict(page) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html[page]))) if (m[1].includes("window.PAGE_I18N")) scripts.push(m[1]);
  assert.equal(scripts.length, 1, `${page}: one inline script defines window.PAGE_I18N`);
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(scripts[0], ctx);
  return ctx.window.PAGE_I18N;
}
function indexDict() {
  const src = html.index;
  const start = src.indexOf("const I18N = ") + "const I18N = ".length;
  const end = src.indexOf("\n    };", start) + "\n    }".length;
  return vm.runInNewContext("(" + src.slice(start, end) + ")");
}
const dictOf = (page) => (page === "index" ? indexDict() : themeDict(page));

function usedKeys(src, withT) {
  const keys = new Set();
  for (const m of src.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)) keys.add(m[1]);
  if (withT) for (const m of src.matchAll(/\bt\(\s*(?:"([^"]+)"|'([^']+)')\s*\)/g)) keys.add(m[1] || m[2]);
  return keys;
}

// Keys that were already missing before cycle 2 and are unrelated to it (none found so far).
const ALLOWLIST = {};

// ── item 8 ──
test("the customer-facing pages and the recovery email contain no old guarantee, trial or no-questions wording", () => {
  assert.deepEqual(Object.keys(SCANNED), [...CUSTOMER_PAGES.map((p) => `public/${p}.html`), ...CUSTOMER_EMAIL_FILES], "the scanned list is the explicit one");
  assert.ok(!("public/admin.html" in SCANNED), "admin.html is not scanned");
  const banned = [/נחזיר את הכסף/, /money back/i, /ניסיון/, /trial/i, /ללא שאלות/, /no questions/i];
  for (const [file, src] of Object.entries(SCANNED)) {
    for (const re of banned) assert.ok(!re.test(src), `${file} matches ${re}`);
  }
});

test("every trustRefund and refundLine element is an <a href=\"/refund.html\"", () => {
  let seen = 0;
  for (const [page, src] of Object.entries(html)) {
    for (const m of src.matchAll(/<[a-zA-Z][^>]*data-i18n="(?:trustRefund|refundLine)"[^>]*>/g)) {
      seen++;
      assert.match(m[0], /^<a\s/, `${page}: ${m[0]}`);
      assert.ok(m[0].includes('href="/refund.html"'), `${page}: ${m[0]}`);
    }
  }
  assert.ok(seen >= 4, "register, dashboard, index and pricing carry the sentence");
});

test("the he and en values of trustRefund and refundLine equal the two full refund sentences", () => {
  const where = { register: "trustRefund", dashboard: "trustRefund", index: "refundLine", pricing: "refundLine" };
  for (const [page, key] of Object.entries(where)) {
    const d = dictOf(page);
    assert.equal(d.he[key], REFUND_HE, `${page}.he.${key}`);
    assert.equal(d.en[key], REFUND_EN, `${page}.en.${key}`);
  }
  // The visible Hebrew fallback in the markup says the same.
  for (const page of ["register", "dashboard", "index", "pricing"]) {
    assert.ok(html[page].includes(`>${REFUND_HE}</a>`), `${page}: markup text`);
  }
});

test("refund.html highlight box holds the Hebrew refund sentence", () => {
  assert.match(html.refund, new RegExp(`<div class="highlight-box">\\s*<p>${REFUND_HE}</p>`));
  assert.ok(html.refund.includes("עדכון אחרון: יוני 2026"), "the rest of refund.html is untouched");
});

test("faq6a in pricing.html carries the core refund sentence in he and en", () => {
  const d = themeDict("pricing");
  assert.ok(d.he.faq6a.startsWith(REFUND_HE_CORE));
  assert.ok(d.en.faq6a.startsWith(REFUND_EN_CORE));
  assert.ok(!d.he.faq6a.includes("↩️") && !d.en.faq6a.includes("↩️"));
});

test("index.html and pricing.html no longer carry the guarantee pill or its keys", () => {
  for (const k of ["guarantee", "heroTrust"]) {
    assert.ok(!html.index.includes(`data-i18n="${k}"`) && !new RegExp(`\\b${k}:`).test(html.index), `index ${k}`);
  }
  for (const k of ["guaranteeTitle", "guaranteeText", "guaranteeContact"]) {
    assert.ok(!html.pricing.includes(k), `pricing ${k}`);
  }
});

// ── item 9 ──
test("the customer-facing pages and the recovery email contain no !!!", () => {
  for (const [file, src] of Object.entries(SCANNED)) assert.ok(!src.includes("!!!"), file);
});

test("no public file contains planBadge or plan-badge, הכי פופולרי or Most Popular", () => {
  for (const f of fs.readdirSync(PUBLIC)) {
    if (!/\.(html|css|js)$/.test(f)) continue;
    const src = read(`public/${f}`);
    for (const bad of ["planBadge", "plan-badge", "הכי פופולרי", "Most Popular"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
});

test("every wa.me URL in public html starts with https://wa.me/972546787932 (the only exception is the share link https://wa.me/? in success.html), and every ?text= value decodes to the general question text", () => {
  let support = 0;
  for (const [page, src] of Object.entries(html)) {
    for (const m of src.matchAll(/https:\/\/wa\.me\/[^"'`\s<>]*/g)) {
      const url = m[0];
      if (url.startsWith("https://wa.me/?")) {
        assert.equal(page, "success", "only success.html may share without a number");
        continue;
      }
      assert.ok(url.startsWith(WA_BASE), `${page}: ${url}`);
      support++;
      const text = url.split("?text=")[1];
      // Links built in page scripts end at the quote and add their own encoded text.
      if (text) assert.equal(decodeURIComponent(text), WA_QUESTION, `${page}: ${url}`);
    }
  }
  assert.ok(support >= 10);
});

test("index.html and register.html each contain both testimonial strings exactly", () => {
  for (const page of ["index", "register"]) {
    for (const s of TESTIMONIALS) {
      const tag = `<blockquote class="testimonial" lang="he" dir="rtl">${s}</blockquote>`;
      assert.equal(html[page].split(tag).length - 1, 1, `${page}: ${s.slice(0, 20)}`);
      assert.equal(html[page].split(">" + s + "<").length - 1, 1);
    }
  }
});

test("register.html shows the testimonials after the PayPal button container", () => {
  const at = html.register.indexOf('id="paypal-button-container"');
  assert.ok(at > 0);
  for (const s of TESTIMONIALS) assert.ok(html.register.indexOf(s) > at, s.slice(0, 20));
});

// ── item 12 ──
test("pricing.html nav has themeLangBtn and themeDarkBtn, index.html no longer defines .nav-tools or .tool-btn, style.css does", () => {
  const nav = html.pricing.match(/<nav class="landing-nav">[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.includes('id="themeLangBtn"') && nav.includes('id="themeDarkBtn"'));
  assert.ok(nav.includes('class="nav-cta"'));
  const inlineStyle = html.index.match(/<style>[\s\S]*?<\/style>/)[0];
  assert.ok(!/\.nav-tools|\.tool-btn/.test(inlineStyle));
  const css = read("public/style.css");
  assert.ok(/\.nav-tools\s*\{/.test(css) && /\.tool-btn\s*\{/.test(css));
});

// ── i18n completeness (AC-9.4) ──
for (const page of ["register", "dashboard", "pricing", "success"]) {
  test(`i18n completeness: ${page}`, () => {
    const d = themeDict(page);
    const allow = ALLOWLIST[page] || [];
    const heKeys = Object.keys(d.he).sort();
    const enKeys = Object.keys(d.en).sort();
    assert.deepEqual(heKeys, enKeys, `${page}: he and en dictionaries have the same keys`);
    const missing = [...usedKeys(html[page], true)].filter((k) => !allow.includes(k) && !(k in d.he && k in d.en));
    assert.deepEqual(missing, [], `${page}: keys used but missing from he/en`);
  });
}

test("i18n completeness: index", () => {
  const d = indexDict();
  assert.deepEqual(Object.keys(d.he).sort(), Object.keys(d.en).sort(), "index: he and en have the same keys");
  const allow = ALLOWLIST.index || [];
  const missing = [...usedKeys(html.index, false)].filter((k) => !allow.includes(k) && !(k in d.he && k in d.en));
  assert.deepEqual(missing, [], "index: keys used but missing from he/en");
});
