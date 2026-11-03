"use strict";
// Offline stand-in for the Supabase client, shared by the admin-list and cleanup-retention tests.
// Not a test file (the underscore keeps it out of tests/*.test.js). It really applies the operations
// the api/ files use (select, insert, update, delete, filters, order, limit) to an in-memory store,
// and logs every executed query in fake.calls so tests can assert on the query structure.
// Any method it does not implement is undefined, so an unsupported call fails loudly (TypeError).
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function createFakeSupabase(seed = {}) {
  const store = {
    events: [],
    rsvps: [],
    pending_checkouts: [],
    checkout_abandonments: [],
    ...structuredClone(seed),
  };
  const calls = [];
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

    function execute() {
      const rows = store[table];
      if (!rows) throw new Error("fake supabase: unknown table " + table);
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
      if (q.op === "update") {
        const targets = hit();
        for (const r of targets) Object.assign(r, structuredClone(q.payload));
        return { data: null, count: targets.length, error: null };
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

  return {
    store,
    calls,
    from(table) { return builder(table); },
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
