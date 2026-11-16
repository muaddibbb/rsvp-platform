"use strict";
// Limited-time promo (₪159 crossed out, only ₪99): static checks on markup, CSS markers and i18n keys.
// Reads public/ as text, evaluates the dictionaries in node:vm. No dependencies, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PAGES = ["index", "pricing", "register"];
const html = Object.fromEntries(PAGES.map((p) => [p, read(`public/${p}.html`)]));
const count = (s, needle) => s.split(needle).length - 1;

function dictOf(page) {
  const src = html[page];
  if (page === "index") {
    const start = src.indexOf("const I18N = ") + "const I18N = ".length;
    const end = src.indexOf("\n    };", start) + "\n    }".length;
    return vm.runInNewContext("(" + src.slice(start, end) + ")");
  }
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) if (m[1].includes("window.PAGE_I18N")) scripts.push(m[1]);
  assert.equal(scripts.length, 1, `${page}: one PAGE_I18N script`);
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(scripts[0], ctx);
  return ctx.window.PAGE_I18N;
}
const promoBlocks = (page) =>
  [...html[page].matchAll(/<!-- PROMO-START -->([\s\S]*?)<!-- PROMO-END -->/g)].map((m) => m[1]);

test("index, pricing and register each contain PROMO-START and PROMO-END exactly once, and the CSS markers once", () => {
  for (const p of PAGES) {
    for (const marker of ["<!-- PROMO-START -->", "<!-- PROMO-END -->", "/* PROMO-CSS-START */", "/* PROMO-CSS-END */"]) {
      assert.equal(count(html[p], marker), 1, `${p}: ${marker}`);
    }
    assert.ok(html[p].indexOf("<!-- PROMO-START -->") < html[p].indexOf("<!-- PROMO-END -->"), p);
    assert.ok(html[p].indexOf("/* PROMO-CSS-START */") < html[p].indexOf("/* PROMO-CSS-END */"), p);
  }
});

test("promo keys exist in he and en with non-empty text and equal key sets per page", () => {
  for (const p of PAGES) {
    const d = dictOf(p);
    const keys = (l) => Object.keys(d[l]).filter((k) => k.startsWith("promo")).sort();
    assert.ok(keys("he").length >= 3, `${p}: has promo keys`);
    assert.deepEqual(keys("en"), keys("he"), `${p}: equal key sets`);
    for (const l of ["he", "en"]) {
      for (const k of keys(l)) assert.ok(typeof d[l][k] === "string" && d[l][k].trim() !== "", `${p}.${l}.${k}`);
    }
    // every promo data-i18n key used in the markup is defined in both languages
    for (const block of promoBlocks(p)) {
      for (const m of block.matchAll(/data-i18n="([^"]+)"/g)) {
        assert.ok(m[1] in d.he && m[1] in d.en, `${p}: ${m[1]} defined`);
      }
    }
  }
});

test("the old price ₪159 sits inside an <s> on each page", () => {
  for (const p of PAGES) assert.match(html[p], /<s class="promo-old">[^]*?₪159<\/s>/, p);
  for (const p of ["index", "pricing"]) assert.match(html[p], /<s class="promo-old promo-old-big" aria-hidden="true">[^]*?₪159<\/s>/, `${p}: big`);
});

test("each <s> has the visually hidden previous-price text and the he/en dictionaries define promoPrev", () => {
  for (const p of PAGES) {
    const blocks = promoBlocks(p);
    assert.equal(blocks.length, 1, p);
    const all = [...blocks[0].matchAll(/<s class="promo-old[^"]*"[^>]*>([^]*?)<\/s>/g)];
    const big = p !== "register";
    assert.ok(all.length >= (big ? 2 : 1), `${p}: <s> count`);
    assert.equal(/promo-old promo-old-big/.test(blocks[0]), big, `${p}: big old price only on index and pricing`);
    for (const s of all) assert.match(s[1], /<span class="promo-sr" data-i18n="promoPrev">/, p);
    const d = dictOf(p);
    assert.equal(d.he.promoPrev, "המחיר הקודם", p);
    assert.equal(d.en.promoPrev, "Previous price", p);
    assert.match(html[p], /\.promo-sr\s*\{[^}]*clip:/, `${p}: promo-sr css`);
  }
});

test("no innerHTML in the promo blocks", () => {
  for (const p of PAGES) {
    for (const block of promoBlocks(p)) assert.ok(!/innerHTML/i.test(block), p);
    // no data-i18n element contains child elements (applyLang replaces children with text)
    for (const block of promoBlocks(p)) {
      for (const m of block.matchAll(/<(span|p|div)\b[^>]*data-i18n="[^"]+"[^>]*>([^]*?)<\/\1>/g)) {
        assert.ok(!/</.test(m[2]), `${p}: data-i18n element is a text-only leaf`);
      }
    }
  }
});

test("the charged price wording is unchanged", () => {
  assert.ok(html.index.includes("צור אירוע עכשיו — ₪99 בלבד"));
  assert.ok(html.index.includes('<span class="price-amount">99</span>'));
  assert.ok(html.index.includes("שלמו ₪99 חד-פעמי"), "step2 wording");
  assert.match(html.register, /<div class="checkout-total-row"[^>]*>[^]*?>₪99</);
  assert.ok(dictOf("pricing").he.faq1a.includes("₪99 הם המחיר הסופי"));
});

test("only the big <s> is aria-hidden, the sentence <s> is not", () => {
  for (const p of ["index", "pricing"]) {
    const tags = [...promoBlocks(p)[0].matchAll(/<s class="promo-old[^"]*"[^>]*>/g)].map((m) => m[0]);
    assert.equal(tags.length, 2, p);
    for (const t of tags) assert.equal(t.includes("promo-old-big"), t.includes('aria-hidden="true"'), `${p}: ${t}`);
  }
  assert.ok(!/aria-hidden/.test(promoBlocks("register")[0]), "register <s> not hidden");
});

test("every dictionary line containing a promo key holds only promo keys and ends with // PROMO", () => {
  for (const p of PAGES) {
    const lines = html[p].split("\n").filter((l) => /^\s+promo\w+: "/.test(l));
    assert.equal(lines.length, 2, `${p}: one he line and one en line`);
    for (const l of lines) {
      assert.ok(/,\s*\/\/ PROMO\s*$/.test(l), `${p}: ${l}`);
      for (const m of l.matchAll(/(\w+): "/g)) assert.ok(m[1].startsWith("promo"), `${p}: ${m[1]}`);
    }
    assert.equal(html[p].split("\n").filter((l) => /\bpromo\w+: "/.test(l)).length, 2, `${p}: no promo key on another line`);
  }
});

test("promo- classes appear in each page only inside the PROMO markers (HTML and CSS)", () => {
  for (const p of ["index", "pricing", "register"]) {
    const src = html[p].replace(/<!-- PROMO-START -->[\s\S]*?<!-- PROMO-END -->/g, "").replace(/\/\* PROMO-CSS-START \*\/[\s\S]*?\/\* PROMO-CSS-END \*\//g, "");
    const left = src.split("\n").filter((l) => /promo-(?!guarantee|banner)/.test(l) && !/\/\/ PROMO\s*$/.test(l));
    assert.deepEqual(left, [], p);
  }
});
