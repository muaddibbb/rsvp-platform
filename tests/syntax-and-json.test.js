// Syntax / validity checks. No dependencies, no network, no side effects.
// Run: node --test /Users/rkuperman/rsvp-platform/tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function walk(dir, pred, out = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

// JS files: compile exactly the way Node's CommonJS loader does (function wrapper,
// so the top-level `return` in automation/rules-engine.js is legal, as it is in n8n).
const jsFiles = [
  ...walk(path.join(ROOT, "api"), (p) => p.endsWith(".js")),
  path.join(ROOT, "automation", "rules-engine.js"),
  path.join(ROOT, "public", "theme.js"),
];

test("there are JS files to check (guards against a silently empty list)", () => {
  assert.ok(jsFiles.length >= 13, `expected >= 13 JS files, found ${jsFiles.length}`);
});

for (const file of jsFiles) {
  test(`JS syntax: ${path.relative(ROOT, file)}`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotThrow(() =>
      vm.compileFunction(src, ["exports", "require", "module", "__filename", "__dirname"], { filename: file })
    );
  });
}

// Inline <script> blocks of each public/*.html (classic scripts, no src attribute).
const htmlFiles = fs.readdirSync(path.join(ROOT, "public")).filter((f) => f.endsWith(".html"));
test("there are HTML files to check", () => assert.ok(htmlFiles.length >= 10));

for (const f of htmlFiles) {
  test(`HTML inline scripts parse: public/${f}`, () => {
    const html = fs.readFileSync(path.join(ROOT, "public", f), "utf8");
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    let n = 0;
    while ((m = re.exec(html))) {
      const attrs = m[1];
      if (/\bsrc\s*=/.test(attrs)) continue; // external script
      const type = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (type && !/^(text|application)\/javascript$|^module$/i.test(type)) continue; // e.g. JSON-LD
      n++;
      assert.doesNotThrow(
        () => new vm.Script(m[2], { filename: `${f}#inline${n}` }),
        `inline script #${n} in ${f} has a syntax error`
      );
    }
  });
}

// n8n workflow.
const wfPath = path.join(ROOT, "automation", "campaign-manager.workflow.json");
let wf;
function loadWf() {
  if (!wf) wf = JSON.parse(fs.readFileSync(wfPath, "utf8"));
  return wf;
}

test("n8n workflow JSON is valid", () => {
  const w = loadWf();
  assert.ok(Array.isArray(w.nodes) && w.nodes.length > 0);
});

test("every workflow connection refers to an existing node name", () => {
  const w = loadWf();
  const names = new Set(w.nodes.map((n) => n.name));
  for (const [from, outs] of Object.entries(w.connections || {})) {
    assert.ok(names.has(from), `connection source "${from}" is not a node`);
    for (const branch of outs.main || [])
      for (const c of branch || []) assert.ok(names.has(c.node), `connection target "${c.node}" is not a node`);
  }
});

test("every workflow Code node's jsCode parses (async function body: top-level return/await allowed)", () => {
  const w = loadWf();
  const codeNodes = w.nodes.filter((n) => n.type === "n8n-nodes-base.code");
  assert.ok(codeNodes.length >= 6, `expected >= 6 Code nodes, got ${codeNodes.length}`);
  for (const n of codeNodes) {
    assert.equal(typeof n.parameters.jsCode, "string", `${n.name}: jsCode missing`);
    assert.doesNotThrow(
      () => new AsyncFunction("$input", "$", "$json", "$node", "$items", n.parameters.jsCode),
      `Code node "${n.name}" has a syntax error`
    );
  }
});
