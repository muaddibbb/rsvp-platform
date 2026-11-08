"use strict";
// Static checks of sql/schema.sql (reconstructed from the code) and sql/release-two-migration.sql: re-runnable,
// nothing destructive, and every column the api reads or writes is in schema.sql. No Postgres, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (sql) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const SCHEMA = stripComments(read("sql/schema.sql"));
const MIGRATION = stripComments(read("sql/release-two-migration.sql"));

for (const [name, sql] of [["schema.sql", SCHEMA], ["release-two-migration.sql", MIGRATION]]) {
  test(`${name}: re-runnable (if not exists / create or replace / on conflict) and nothing destructive`, () => {
    assert.ok(!/\b(drop|delete|truncate)\b/i.test(sql), "no drop, delete or truncate");
    for (const m of sql.matchAll(/create\s+(?:unique\s+)?(table|index)\s+(?!if not exists)/gi)) assert.fail("create " + m[1] + " without if not exists");
    for (const m of sql.matchAll(/add\s+column\s+(?!if not exists)/gi)) assert.fail("add column without if not exists");
    for (const m of sql.matchAll(/create\s+(?!or replace)(?:function|unique|table|index)/gi)) {
      assert.ok(/^create\s+(unique\s+)?(table|index)\s+if not exists/i.test(sql.slice(m.index)), "unguarded: " + sql.slice(m.index, m.index + 40));
    }
    for (const m of sql.matchAll(/\binsert\s+into\s+public\.(\w+)[^;]*;/gi)) {
      if (m[1] === "rate_limits") continue;   // inside the plpgsql body of rate_limit_hit (an upsert with on conflict)
      assert.match(m[0], /on conflict/i, "insert must be on conflict do nothing");
    }
  });
}

test("migration is one transaction and adds exactly the release-two objects", () => {
  assert.equal((MIGRATION.match(/\bbegin;/gi) || []).length, 1);
  assert.equal((MIGRATION.match(/\bcommit;/gi) || []).length, 1);
  for (const token of [
    "add column if not exists receipt_number integer", "add column if not exists refunded_at timestamptz",
    "events_receipt_number_key", "where receipt_number is not null",
    "create table if not exists public.receipt_counter", "create table if not exists public.rate_limits",
    "create or replace function public.assign_receipt_number(p_slug text)",
    "create or replace function public.rate_limit_hit(p_key text, p_window_s integer, p_limit integer)",
    "for update", "security definer",
  ]) assert.ok(MIGRATION.toLowerCase().includes(token), "missing: " + token);
});

test("migration backfill numbers existing paid events in paid_at order, after any number already used", () => {
  assert.match(MIGRATION, /row_number\(\) over \(order by paid_at, id\)/);
  assert.match(MIGRATION, /where paid_at is not null and receipt_number is null/);
  assert.match(MIGRATION, /receipt_number = b\.m \+ o\.rn/);
  assert.match(MIGRATION, /greatest\(last_number, \(select coalesce\(max\(receipt_number\), 0\) from public\.events\)\)/);
});

test("the functions are callable by the server only", () => {
  assert.match(MIGRATION, /revoke all on function public\.assign_receipt_number\(text\) from public, anon, authenticated/);
  assert.match(MIGRATION, /grant execute on function public\.assign_receipt_number\(text\) to service_role/);
  assert.match(MIGRATION, /grant execute on function public\.rate_limit_hit\(text, integer, integer\) to service_role/);
});

test("the RPC argument names used by the api match the SQL parameter names", () => {
  const all = fs.readdirSync(path.join(ROOT, "api")).filter((f) => f.endsWith(".js")).map((f) => read("api/" + f)).join("\n");
  assert.match(all, /rpc\("assign_receipt_number", \{ p_slug:/);
  assert.match(all, /rpc\("rate_limit_hit", \{ p_key:[^}]*p_window_s:[^}]*p_limit:/);
});

test("RLS is enabled on every table in schema.sql", () => {
  const tables = [...SCHEMA.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(tables.sort(), ["checkout_abandonments", "events", "pending_checkouts", "rate_limits", "receipt_counter", "rsvps"]);
  for (const t of tables) assert.match(SCHEMA, new RegExp(`alter table public\\.${t} enable row level security`), t);
});

// ---- every column the api touches is defined ----
function columnsOf(table) {
  const m = new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`, "i").exec(SCHEMA);
  assert.ok(m, "table " + table);
  return new Set(m[1].split("\n").map((l) => l.trim()).filter((l) => l && !/^(primary|unique|check|constraint|foreign)/i.test(l)).map((l) => l.split(/\s+/)[0]));
}

// Columns named in .select("...") literals, attributed to the nearest preceding .from("table").
function selectedColumns() {
  const out = {};
  const files = [];
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { if (f.name !== "fonts") walk(p); } else if (p.endsWith(".js")) files.push(p); } };
  walk(path.join(ROOT, "api"));
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    let table = null;
    for (const m of src.matchAll(/\.from\("(\w+)"\)|\.select\(\s*"([^"]*)"|\.select\(\s*`([^`]*)`|const LIST_COLS = "([^"]*)"/g)) {
      if (m[1]) { table = m[1]; continue; }
      const list = m[2] || m[3] || m[4];
      if (list === undefined || !table) continue;
      for (let c of list.split(",").map((s) => s.trim())) {
        if (!c || c === "*" || c.startsWith("$") || c.includes("(")) continue;
        (out[table] = out[table] || new Set()).add(c);
      }
    }
  }
  return out;
}

test("every column the api selects exists in schema.sql", () => {
  const sel = selectedColumns();
  assert.ok(sel.events && sel.events.size > 15, "the extractor found the events columns");
  for (const [table, cols] of Object.entries(sel)) {
    if (table === "rate_limits") continue;
    const have = columnsOf(table);
    const missing = [...cols].filter((c) => !have.has(c));
    assert.deepEqual(missing, [], `${table}: selected but not in schema.sql: ${missing.join(", ")}`);
  }
  assert.ok(sel.events.has("dashboard_password") && sel.events.has("final_guests") && sel.events.has("receipt_number") && sel.events.has("refunded_at"));
});

test("every column the api inserts, upserts, updates or filters on exists in schema.sql", () => {
  const written = {
    events: ["slug", "customer_name", "customer_email", "customer_phone", "event_type", "event_name", "hebrew_date", "gregorian_date",
      "event_time", "location", "address", "extra_note", "dashboard_password", "paid_at", "active", "final_responses", "final_guests",
      "receipt_number", "refunded_at", "id"],
    rsvps: ["event_id", "name", "attending", "guests", "notes", "created_at", "id"],
    pending_checkouts: ["id", "customer_name", "customer_email", "customer_phone", "event_type", "event_name", "gregorian_date", "event_time", "location", "updated_at", "notified"],
    checkout_abandonments: ["abandoned_at", "event_type", "id"],
    rate_limits: ["key", "window_start", "hits"],
    receipt_counter: ["id", "last_number"],
  };
  for (const [table, cols] of Object.entries(written)) {
    const have = columnsOf(table);
    assert.deepEqual(cols.filter((c) => !have.has(c)), [], table);
  }
  // and the insert/upsert objects in the code really use only those names (guards the list above)
  const capture = read("api/paypal-capture.js");
  const upsert = /pending_checkouts"\)\.upsert\(\{([\s\S]*?)\}, \{ onConflict/.exec(capture)[1];
  for (const k of [...upsert.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])) assert.ok(written.pending_checkouts.includes(k), "pending_checkouts." + k);
  const ins = /from\("events"\)\.insert\(\{([\s\S]*?)\}\);/.exec(capture)[1];
  for (const k of [...ins.matchAll(/^\s*(\w+)[:,]/gm)].map((m) => m[1])) assert.ok(written.events.includes(k), "events." + k);
});

test("schema.sql says it is reconstructed from code and not the live export", () => {
  assert.match(read("sql/schema.sql"), /RECONSTRUCTED FROM CODE/);
});
