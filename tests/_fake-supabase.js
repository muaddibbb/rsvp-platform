"use strict";
// Offline stand-in for the Supabase client, shared by the admin-list and cleanup-retention tests.
// Not a test file (the underscore keeps it out of tests/*.test.js). It really applies the operations
// the api/ files use (select, insert, update, delete, filters, order, limit) to an in-memory store,
// and logs every executed query in fake.calls so tests can assert on the query structure.
// Any method it does not implement is undefined, so an unsupported call fails loudly (TypeError).
// Release two additions:
//  - update(...).select(cols) returns the updated rows in data (like PostgREST with Prefer: return=representation).
//  - rpc(name, args): handlers are injectable (opts.rpc), and by default the fake implements the two SQL
//    functions of sql/release-two-migration.sql: assign_receipt_number(p_slug) and rate_limit_hit(p_key,
//    p_window_s, p_limit). Every call is logged in fake.rpcCalls.
//  - opts.migrated = false simulates a database where the owner has NOT run the migration yet: the new
//    events columns (receipt_number, refunded_at) answer 42703 when named in a select/filter/order/write,
//    the tables receipt_counter and rate_limits answer 42P01, and rpc() answers PGRST202 (function missing).
//    `select("*")` still works and rows simply lack the new columns, like the real database.
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const NEW_EVENT_COLUMNS = ["receipt_number", "refunded_at"];

function createFakeSupabase(seed = {}, opts = {}) {
  const migrated = opts.migrated !== false;
  const store = {
    events: [],
    rsvps: [],
    pending_checkouts: [],
    checkout_abandonments: [],
    ...(migrated ? { receipt_counter: [{ id: 1, last_number: 0 }], rate_limits: [] } : {}),
    ...structuredClone(seed),
  };
  // Like the migration's backfill: the counter starts at the highest number already stored on a seeded event.
  if (migrated && store.receipt_counter[0]) {
    const top = Math.max(0, ...store.events.map((e) => e.receipt_number || 0));
    store.receipt_counter[0].last_number = Math.max(store.receipt_counter[0].last_number, top);
  }
  const missingTables = new Set(opts.missingTables || (migrated ? [] : ["receipt_counter", "rate_limits"]));
  const missingColumns = opts.missingColumns || (migrated ? {} : { events: NEW_EVENT_COLUMNS });
  const calls = [];
  const rpcCalls = [];
  let nextId = 1;

  const isNull = (v) => v === null || v === undefined;

  function matches(row, f) {
    const v = row[f.col];
    switch (f.type) {
      case "eq":      return v === f.value;
      case "neq":     return v !== f.value;
      case "lt":      return v < f.value;
      case "lte":     return v <= f.value;
      case "gt":      return v > f.value;
      case "gte":     return v >= f.value;
      case "in":      return f.value.includes(v);
      case "is":      return isNull(v);
      case "not_is":  return !isNull(v);
      default:        throw new Error("fake supabase: unknown filter " + f.type);
    }
  }

  function project(table, row, cols) {
    if (!cols || cols.trim() === "*") return { ...row };
    const names = cols.split(",").map((c) => c.trim()).filter(Boolean);
    const out = {};
    for (const n of names) {
      if (n === "rsvps(count)") continue;
      if (n === "*") { Object.assign(out, row); continue; }
      out[n] = row[n];
    }
    if (table === "events" && names.includes("rsvps(count)")) {
      out.rsvps = [{ count: store.rsvps.filter((r) => r.event_id === row.id).length }];
    }
    return out;
  }

  function builder(table) {
    const q = {
      table, op: null, cols: null, opts: null, filters: [], order: null, limit: null, payload: null, single: false,
    };

    // Names of the columns a query touches (for the "column does not exist" simulation).
    function touchedColumns() {
      const out = [];
      if (q.cols && q.cols.trim() !== "*") out.push(...q.cols.split(",").map((c) => c.trim()).filter((c) => c && c !== "*" && !c.includes("(")));
      for (const f of q.filters) out.push(f.col);
      if (q.order) out.push(q.order.col);
      const payloads = Array.isArray(q.payload) ? q.payload : q.payload ? [q.payload] : [];
      for (const p of payloads) out.push(...Object.keys(p));
      return out;
    }

    function execute() {
      if (missingTables.has(table)) {
        calls.push({ table, op: q.op, cols: q.cols, filters: q.filters.map((f) => ({ ...f })), order: null, payload: null, error: "42P01" });
        return { data: null, count: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      }
      const rows = store[table];
      if (!rows) throw new Error("fake supabase: unknown table " + table);
      const missing = (missingColumns[table] || []).find((c) => touchedColumns().includes(c));
      if (missing) {
        calls.push({ table, op: q.op, cols: q.cols, filters: q.filters.map((f) => ({ ...f })), order: null, payload: null, error: "42703" });
        return { data: null, count: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } };
      }
      const log = {
        table, op: q.op, cols: q.cols,
        filters: q.filters.map((f) => ({ ...f })),
        order: q.order ? { ...q.order } : null,
        payload: q.payload === null ? null : structuredClone(q.payload),
      };
      calls.push(log);

      const hit = () => rows.filter((r) => q.filters.every((f) => matches(r, f)));

      if (q.op === "insert") {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const item of list) {
          const row = structuredClone(item);
          if (row.id === undefined) row.id = nextId++;
          rows.push(row);
        }
        return { data: null, count: null, error: null };
      }
      if (q.op === "upsert") {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        const col = (q.opts && q.opts.onConflict) || "id";
        for (const item of list) {
          const existing = rows.find((r) => r[col] === item[col]);
          if (existing) Object.assign(existing, structuredClone(item));
          else rows.push(structuredClone(item));
        }
        return { data: null, count: null, error: null };
      }
      if (q.op === "update") {
        const targets = hit();
        for (const r of targets) Object.assign(r, structuredClone(q.payload));
        const data = q.cols ? targets.map((r) => project(table, r, q.cols)) : null;
        return { data, count: targets.length, error: null };
      }
      if (q.op === "delete") {
        const targets = new Set(hit());
        store[table] = rows.filter((r) => !targets.has(r));
        return { data: null, count: targets.size, error: null };
      }
      if (q.op === "select" || q.op === null) {
        let found = hit();
        if (q.opts && q.opts.head) {
          return { data: null, count: found.length, error: null };
        }
        if (q.order) {
          const { col, ascending } = q.order;
          found = found.slice().sort((a, b) => {
            if (a[col] === b[col]) return 0;
            return (a[col] < b[col] ? -1 : 1) * (ascending ? 1 : -1);
          });
        }
        if (q.limit !== null) found = found.slice(0, q.limit);
        const data = found.map((r) => project(table, r, q.cols));
        const count = q.opts && q.opts.count ? hit().length : null;
        if (q.single) return { data: data[0] || null, count, error: null };
        return { data, count, error: null };
      }
      throw new Error("fake supabase: unknown op " + q.op);
    }

    const api = {
      select(cols, opts) {
        if (q.op === null) q.op = "select";
        q.cols = cols === undefined ? "*" : cols;
        q.opts = opts || null;
        return api;
      },
      insert(payload) { q.op = "insert"; q.payload = payload; return api; },
      update(payload) { q.op = "update"; q.payload = payload; return api; },
      upsert(payload, opts) { q.op = "upsert"; q.payload = payload; q.opts = opts || null; return api; },
      delete() { q.op = "delete"; return api; },
      eq(col, value)  { q.filters.push({ type: "eq", col, value }); return api; },
      neq(col, value) { q.filters.push({ type: "neq", col, value }); return api; },
      lt(col, value)  { q.filters.push({ type: "lt", col, value }); return api; },
      lte(col, value) { q.filters.push({ type: "lte", col, value }); return api; },
      gt(col, value)  { q.filters.push({ type: "gt", col, value }); return api; },
      gte(col, value) { q.filters.push({ type: "gte", col, value }); return api; },
      in(col, value)  { q.filters.push({ type: "in", col, value }); return api; },
      is(col, value) {
        if (value !== null) throw new Error("fake supabase: is() only supports null");
        q.filters.push({ type: "is", col, value: null });
        return api;
      },
      not(col, operator, value) {
        if (operator !== "is" || value !== null) throw new Error("fake supabase: not() only supports (col, 'is', null)");
        q.filters.push({ type: "not_is", col, value: null });
        return api;
      },
      order(col, opts) { q.order = { col, ascending: !(opts && opts.ascending === false) }; return api; },
      limit(n) { q.limit = n; return api; },
      maybeSingle() { q.single = true; return api; },
      then(resolve, reject) {
        try { return Promise.resolve(execute()).then(resolve, reject); }
        catch (err) { return Promise.reject(err).then(resolve, reject); }
      },
    };
    return api;
  }

  // ---- rpc ----
  const defaultRpc = {
    assign_receipt_number({ p_slug }) {
      const ev = store.events.find((e) => e.slug === p_slug);
      if (!ev || ev.paid_at === null || ev.paid_at === undefined) return { data: null, error: null };
      if (ev.receipt_number !== null && ev.receipt_number !== undefined) return { data: ev.receipt_number, error: null };
      const counter = store.receipt_counter[0];
      counter.last_number += 1;
      ev.receipt_number = counter.last_number;
      return { data: ev.receipt_number, error: null };
    },
    rate_limit_hit({ p_key, p_window_s, p_limit }) {
      const now = Date.now();
      let row = store.rate_limits.find((r) => r.key === p_key);
      if (!row || Date.parse(row.window_start) + p_window_s * 1000 <= now) {
        if (row) { row.window_start = new Date(now).toISOString(); row.hits = 1; }
        else store.rate_limits.push({ key: p_key, window_start: new Date(now).toISOString(), hits: 1 });
        return { data: 1 <= p_limit, error: null };
      }
      row.hits += 1;
      return { data: row.hits <= p_limit, error: null };
    },
  };
  const rpcHandlers = { ...(migrated ? defaultRpc : {}), ...(opts.rpc || {}) };

  return {
    store,
    calls,
    rpcCalls,
    from(table) { return builder(table); },
    rpc(name, args = {}) {
      rpcCalls.push({ name, args: structuredClone(args) });
      const run = () => {
        const h = rpcHandlers[name];
        if (!h) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } };
        return h(args, store);
      };
      return {
        then(resolve, reject) {
          try { return Promise.resolve(run()).then(resolve, reject); }
          catch (err) { return Promise.reject(err).then(resolve, reject); }
        },
      };
    },
  };
}

// Make require("@supabase/supabase-js") inside api/ return this fake. Call before any require of an api/ file.
function install(fake) {
  const id = require.resolve("@supabase/supabase-js", { paths: [path.join(ROOT, "api")] });
  require.cache[id] = { id, filename: id, loaded: true, exports: { createClient: () => fake } };
}

// Minimal Express-like response object for calling the handlers directly.
function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    end(buf) { if (buf !== undefined) res.body = buf; return res; },
    setHeader(k, v) { res.headers[k] = v; return res; },
  };
  return res;
}

module.exports = { createFakeSupabase, install, makeRes };
