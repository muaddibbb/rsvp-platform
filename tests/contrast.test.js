"use strict";
// Link and note contrast (WCAG 2.x relative luminance) for the colours changed in this release, read from
// the real files by regex: pricing FAQ links, the success page help e-mail links and spam note, and the
// inline WhatsApp link. Static: reads public/ as text. No browser, no network, no dependencies.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const pricing = read("public/pricing.html");
const success = read("public/success.html");
const css = read("public/style.css");

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The colour of `selector { ... color: X ... }` (a plain `color:`, not background-color), resolving var(--navy).
function colourOf(src, selector) {
  const m = new RegExp("(?:^|[\\s}])" + esc(selector) + "\\s*\\{([^}]*)\\}", "m").exec(src);
  assert.ok(m, `rule not found: ${selector}`);
  const c = /(?:^|[\s;])color:\s*([^;]+?)\s*(?:;|$)/.exec(m[1]);
  assert.ok(c, `no color in: ${selector}`);
  const v = c[1].trim();
  if (v === "var(--navy)") return "#1a2744";
  assert.match(v, /^#[0-9a-f]{6}$/i, `${selector}: expected a hex colour, got ${v}`);
  return v.toLowerCase();
}

// [file source, selector, background, expected ratio (documented), label]
function check(rows) {
  for (const [src, selector, bg, expected] of rows) {
    const fg = colourOf(src, selector);
    const r = ratio(fg, bg);
    assert.ok(r >= 4.5, `${selector} ${fg} on ${bg} is ${r.toFixed(2)}:1, below 4.5`);
    assert.ok(Math.abs(r - expected) < 0.05, `${selector} ${fg} on ${bg}: expected about ${expected}, got ${r.toFixed(2)}`);
  }
}

test("contrast: pricing FAQ links", () => {
  check([
    [pricing, ".faq-a a", "#f4f1eb", 5.65],
    [pricing, "html.dark .faq-a a", "#0f172a", 11.93],
  ]);
  assert.ok(!/\.faq-a a \{ color: var\(--gold\)/.test(pricing), "the low-contrast gold link rule is gone");
});

test("contrast: success help-mail links", () => {
  check([
    [success, ".help-mail a", "#f4f1eb", 13.14],
    [success, "html.dark .help-mail a", "#0f172a", 11.93],
  ]);
});

test("contrast: wa-inline", () => {
  check([
    [css, ".wa-inline", "#ffffff", 7.67],
    [css, ".wa-inline", "#f4f1eb", 6.80],
    [css, "html.dark .wa-inline", "#0f172a", 10.25],
    [css, "html.dark .wa-inline", "#1e293b", 8.40],
  ]);
});

test("contrast: spam-note", () => {
  check([
    [success, ".spam-note", "#fdf5e0", 6.95],
    [success, "html.dark .spam-note", "#3a3320", 8.45],
  ]);
});

test("contrast: help-mail paragraphs are tagged", () => {
  const paras = success.match(/<p[^>]*>\s*<a href="mailto:kupernetservice@gmail\.com">/g) || [];
  assert.equal(paras.length, 2, "the not-found and verify-error help paragraphs");
  for (const p of paras) assert.ok(p.includes('class="help-mail"'), p);
});
