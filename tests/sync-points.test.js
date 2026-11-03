// Guards for values that are duplicated by hand across files (see design.md section 7 "Values that must stay in sync").
// Static text checks only: no network, no dependencies, nothing is executed.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const has = (src, token) => new RegExp("(^|[^A-Za-z0-9_])" + token + "(?![A-Za-z0-9_])").test(src);

const EVENT_TYPES = ["bar_mitzvah", "bat_mitzvah", "wedding", "brit", "brit_bat", "birthday", "bachelor", "bachelorette", "henna", "family", "other"];
const FILES_WITH_TYPE_TABLE = ["public/register.html", "public/rsvp.html", "public/admin.html", "api/create-event.js", "api/paypal-capture.js", "api/_sweep.js"];

for (const f of FILES_WITH_TYPE_TABLE) {
  test(`all 11 event types are present in ${f}`, () => {
    const src = read(f);
    const missing = EVENT_TYPES.filter((t) => !has(src, t));
    assert.deepEqual(missing, [], `${f} is missing event types: ${missing.join(", ")}`);
  });
}

test("the only amount actually charged is 99.00 ILS (api/paypal-create-order.js)", () => {
  const src = read("api/paypal-create-order.js");
  assert.match(src, /currency_code:\s*"ILS"\s*,\s*value:\s*"99\.00"/);
});

test("the Google Ads conversion value on success.html is 99 ILS", () => {
  const src = read("public/success.html");
  assert.match(src, /value['"]?\s*:\s*99/);
  assert.match(src, /currency['"]?\s*:\s*['"]ILS['"]/);
});

test("rules-engine PRICE_ILS is 99 in both the file and the workflow's inline copy", () => {
  const wf = JSON.parse(read("automation/campaign-manager.workflow.json"));
  const inline = wf.nodes.find((n) => n.name === "Rules Engine").parameters.jsCode;
  assert.match(read("automation/rules-engine.js"), /PRICE_ILS:\s*99\b/);
  assert.match(inline, /PRICE_ILS:\s*99\b/);
});

test("no page or API file mentions a stale 149 price", () => {
  const files = [...fs.readdirSync(path.join(ROOT, "public")).filter((f) => /\.(html|js|css)$/.test(f)).map((f) => "public/" + f), ...FILES_WITH_TYPE_TABLE.filter((f) => f.startsWith("api/")), "api/paypal-create-order.js", "api/_receipt.js"];
  for (const f of files) assert.ok(!/149/.test(read(f)), `${f} contains "149"`);
});

test("declared-but-unused dependencies stay unused (documents J-29: resend, stripe, pdfmake, @fontsource/*)", () => {
  const deps = Object.keys(JSON.parse(read("package.json")).dependencies);
  const code = [...fs.readdirSync(path.join(ROOT, "api")).filter((f) => f.endsWith(".js")).map((f) => read("api/" + f))].join("\n");
  const used = deps.filter((d) => code.includes(`"${d}"`) || code.includes(`'${d}'`));
  // If a package starts being used this fails on purpose: update the test (and drop the package from the J-29 list).
  assert.deepEqual(used.sort(), ["@supabase/supabase-js", "pdfkit"]);
});

test("the Vercel Hobby function budget: api/ has at most 12 non-underscore function files (9 today)", () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "fonts" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const fns = walk(path.join(ROOT, "api")).filter((p) => p.endsWith(".js") && !path.basename(p).startsWith("_"));
  assert.ok(fns.length <= 12, `${fns.length} functions exceeds the Hobby cap of 12`);
  assert.equal(fns.length, 9);
});
