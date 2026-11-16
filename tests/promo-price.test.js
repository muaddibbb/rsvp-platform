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
    const src = html[p].replace(/<!-- PROMO-START -->[\s\S]*?<!-- PROMO-END -->/g, "").replace(/\/\* PROMO-CSS-START \*\/[\s\S]*?\/\* PROMO-CSS-END \*\//g, "").replace(/<!-- PROMO-HERO-START -->[\s\S]*?<!-- PROMO-HERO-END -->/g, "").replace(/\/\* PROMO-HERO-CSS-START \*\/[\s\S]*?\/\* PROMO-HERO-CSS-END \*\//g, "");
    const left = src.split("\n").filter((l) => /promo-(?!guarantee|banner)/.test(l) && !/\/\/ PROMO\s*$/.test(l));
    assert.deepEqual(left, [], p);
  }
});

// Hero promo group (run 20261116-1248-promo-hero): own markers, existing keys only, button unchanged.
const heroBlock = () => {
  const m = /<!-- PROMO-HERO-START -->([\s\S]*?)<!-- PROMO-HERO-END -->/.exec(html.index);
  assert.ok(m, "hero block");
  return m[1];
};

test("hero promo markers appear exactly once on index and not on other pages, in order, before the CTA", () => {
  for (const marker of ["<!-- PROMO-HERO-START -->", "<!-- PROMO-HERO-END -->", "/* PROMO-HERO-CSS-START */", "/* PROMO-HERO-CSS-END */"]) {
    assert.equal(count(html.index, marker), 1, marker);
    for (const p of ["pricing", "register"]) assert.equal(count(html[p], marker), 0, `${p}: ${marker}`);
  }
  assert.ok(html.index.indexOf("<!-- PROMO-HERO-START -->") < html.index.indexOf("<!-- PROMO-HERO-END -->"));
  assert.ok(html.index.indexOf("/* PROMO-HERO-CSS-START */") < html.index.indexOf("/* PROMO-HERO-CSS-END */"));
  assert.ok(html.index.indexOf("<!-- PROMO-HERO-END -->") < html.index.indexOf('data-i18n="heroCta"'));
  assert.ok(html.index.indexOf("<!-- PROMO-HERO-START -->") > html.index.indexOf('class="landing-hero"'));
});

test("hero promo block uses only the existing promo keys, a real <s> with hidden previous-price text, no innerHTML", () => {
  const b = heroBlock();
  const keys = [...b.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["promoBadge", "promoInstead", "promoOnly", "promoPrev", "promoUrgency"]);
  const d = dictOf("index");
  for (const k of keys) assert.ok(k in d.he && k in d.en, k);
  assert.match(b, /<s class="promo-old">\s*<span class="promo-sr" data-i18n="promoPrev">[^<]*<\/span> ₪159<\/s>/);
  assert.ok(!/aria-hidden/.test(b), "single crossed price: not aria-hidden");
  assert.ok(!/innerHTML/i.test(b));
  for (const m of b.matchAll(/<(span|p|div)\b[^>]*data-i18n="[^"]+"[^>]*>([^]*?)<\/\1>/g)) assert.ok(!/</.test(m[2]), "text-only leaf");
});

test("the hero CTA button text and link are unchanged and the existing price-block promo stays", () => {
  assert.ok(html.index.includes('<a class="cta-btn" href="/register.html" data-i18n="heroCta">צור אירוע עכשיו — ₪99 בלבד 🎉</a>'));
  assert.equal(promoBlocks("index").length, 1);
});

test("every hero promo colour selector has a light and an html.dark twin that outrank the html.dark .promo-* rules", () => {
  const m = /\/\* PROMO-HERO-CSS-START \*\/([\s\S]*?)\/\* PROMO-HERO-CSS-END \*\//.exec(html.index);
  assert.ok(m, "hero css block");
  const rules = [...m[1].matchAll(/([^{}]+)\{([^}]*)\}/g)].map((r) => ({ sel: r[1].split(",").map((x) => x.trim()), body: r[2] }));
  for (const el of ["promo-badge", "promo-line", "promo-urgency", "promo-old"]) {
    const rule = rules.find((r) => r.sel.includes(`html.dark .promo-hero .${el}`));
    assert.ok(rule, `${el}: dark twin`);
    assert.ok(rules.some((r) => r.sel.includes(`html .promo-hero .${el}`)), `${el}: light twin`);
    assert.match(rule.body, /color:/, el);
  }
  assert.match(m[1], /\.promo-hero\s*\{[^}]*overflow-wrap:\s*anywhere/);
  // no bare `.promo-hero .promo-x` colour rule that the html.dark rules (0,2,1) would beat
  for (const r of rules) for (const s of r.sel) assert.ok(!/^\.promo-hero\s+\./.test(s), `outranked selector: ${s}`);
});
