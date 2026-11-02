"use strict";
// Static checks for the release's non-code files: the read-only schema export (sql/export-schema.sql), the
// idempotent table script (sql/checkout_abandonments.sql), the read-only smoke check (scripts/smoke-check.sh)
// and the ignore files. No Postgres, no network: the shell script is only syntax-checked with `bash -n`.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("export-schema.sql is one read-only statement", () => {
  const raw = read("sql/export-schema.sql");
  assert.ok(/READ-ONLY/.test(raw) && /table rows/.test(raw), "the header says READ-ONLY and mentions table rows");
  // Strip `--` comments first, then '...' string literals ('' is an escaped quote inside a literal).
  const noComments = raw.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  const code = noComments.replace(/'(?:[^']|'')*'/g, "''").trim();
  assert.equal((code.match(/;/g) || []).length, 1, "exactly one semicolon");
  assert.ok(code.endsWith(";"), "the semicolon is the last character");
  assert.match(code, /^(with|select)\b/i, "starts with WITH or SELECT");
  const banned = "insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|comment|vacuum|call|do|set|begin|commit|rollback|lock|refresh|reindex|cluster|execute|perform".split("|");
  for (const word of banned) {
    assert.ok(!new RegExp(`\\b${word}\\b`, "i").test(code), `the statement contains the word "${word}"`);
  }
});

test("checkout_abandonments.sql is idempotent and has no destructive statement", () => {
  const sql = read("sql/checkout_abandonments.sql").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
  assert.match(sql, /create table if not exists/i);
  assert.match(sql, /enable row level security/i);
  assert.ok(!/\b(drop|delete|truncate)\b/i.test(sql), "no drop, delete or truncate");
});

test("smoke-check.sh is read-only and parses", () => {
  const file = path.join(ROOT, "scripts", "smoke-check.sh");
  const parsed = spawnSync("bash", ["-n", file], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  const src = fs.readFileSync(file, "utf8");
  for (const bad of [/(^|\s)-X(\s|$)/, /--request/, /(^|\s)-d\s/, /--data/, /(^|\s)-F\s/, /--upload-file/, /Authorization/i, /success\?slug/]) {
    assert.ok(!bad.test(src), `smoke-check.sh matches ${bad}`);
  }
  const curls = [...src.matchAll(/\bcurl\s+([^|)\n]*)/g)].map((m) => m[1]);
  assert.ok(curls.length >= 4, "the script makes curl calls");
  for (const args of curls) {
    const flags = args.split(/\s+/).filter((a) => /^-/.test(a));
    for (const f of flags) assert.ok(["-s", "-o", "-m", "-w"].includes(f), `curl flag ${f} is not a plain GET flag`);
  }
  assert.match(src, /BASE="\$\{1:-https:\/\/rsvp\.kupernet\.com\}"/, "the default base is production");
});

test("gitignore and vercelignore keep run folders and env files out", () => {
  const lines = (rel) => read(rel).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(lines(".gitignore").includes(".atreides/"));
  const v = lines(".vercelignore");
  for (const need of [".atreides", ".env", ".env.*"]) assert.ok(v.includes(need), `.vercelignore has ${need}`);
  for (const bad of ["public", "api", "vercel.json", "tests", "tests/"]) assert.ok(!v.includes(bad), `.vercelignore must not list ${bad}`);
});
