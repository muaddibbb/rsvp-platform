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
    assert.match(args, /(^|\s)-m 10\s/, `curl call has a 10 s limit: ${args}`);
  }
  assert.match(src, /BASE="https:\/\/rsvp\.kupernet\.com"/, "the default base is production");
  assert.match(src, /\[ "\$TOTAL" -gt 540 \] && TOTAL=540/, "the overall deadline is capped at 540 s");
});

// The command is the first backtick span of a Deploy line; the prose after it may mention anything.
const commandOf = (line) => { const m = (line || "").match(/`([^`]+)`/); assert.ok(m, `a backtick command in: ${line}`); return m[1]; };

test("CLAUDE.md Deploy rollback command (inside the backticks) names an explicit deployment id", () => {
  const lines = read("CLAUDE.md").split("\n");
  const rollback = lines.find((l) => l.startsWith("- Production rollback:"));
  assert.ok(rollback, "the Production rollback line exists");
  assert.match(commandOf(rollback), /npx vercel rollback <previous-deployment-id> --timeout 5m$/, "the command passes the recorded deployment id");
  const prev = lines.find((l) => l.startsWith("- Production previous deployment:"));
  assert.match(commandOf(prev), /npx vercel inspect rsvp\.kupernet\.com --json$/, "the previous deployment command is the read-only inspect");
});

const deployLines = () => {
  const text = read("CLAUDE.md");
  const start = text.indexOf("\n### Deploy\n");
  assert.ok(start >= 0, "CLAUDE.md has a ### Deploy section");
  const rest = text.slice(start + 12);
  const end = rest.search(/\n##+ /);
  return (end < 0 ? rest : rest.slice(0, end)).split("\n");
};

test("CLAUDE.md Deploy section declares model B: no deploy command, a wait line, previous deployment before the merge", () => {
  const lines = deployLines();
  const find = (prefix) => lines.find((l) => l.startsWith(prefix));
  const status = find("- Deploy config status:");
  assert.ok(status, "the Deploy config status line exists");
  assert.match(status, /^- Deploy config status: CONFIRMED 2026-11-03 by the owner /);
  assert.match(status, /"I confirm the Deploy section in CLAUDE\.md as written"/);
  assert.ok(!/PROPOSED 2026-11-02/.test(status) && !/treat every value below as UNKNOWN/.test(status), "the old PROPOSED status text is gone");
  for (const p of ["- Merge method:", "- Production previous deployment:", "- Production deploy:", "- Production checkout:", "- Production wait:", "- Production smoke check:", "- Production rollback:", "- Staging deploy:"]) {
    assert.ok(find(p), `the Deploy line ${p} exists`);
  }
  const deploy = find("- Production deploy:");
  assert.ok(deploy, "the Production deploy line exists");
  assert.ok(deploy.startsWith("- Production deploy: none"), "Production deploy is none");
  assert.match(deploy, /Git integration deploys `main`/);
  assert.match(deploy, /must not run any deploy command/);
  assert.ok(!/`cd [^`]*vercel (--prod|deploy)/.test(deploy), "no deploy command inside backticks");

  const wait = find("- Production wait:");
  assert.ok(wait, "the Production wait line exists");
  assert.match(commandOf(wait), /bash scripts\/wait-for-deploy\.sh <previous-deployment-id> 360$/);
  assert.match(wait, /timeout set to 600000 ms/, "the Bash tool timeout is stated");
  assert.match(wait, /540 s plus one 10 s request, about 550 s/, "the time claim is exact");
  assert.match(wait, /Bash tool timeout set to 600000 ms/);
  assert.match(wait, /WAIT_INSPECT_CMD[^.]*unset|ignored unless WAIT_TEST_MODE/, "the test knob is not used in a release");
  assert.match(wait, /`id` differs from the recorded id AND `readyState` is `READY`/, "live = deployment identity");
  assert.match(wait, /DEPLOY TIMEOUT[^.]*report BLOCKED, do NOT roll back/, "timeout with the id unchanged: BLOCKED, no rollback");
  assert.match(wait, /Vercel dashboard/);
  assert.match(wait, /DEPLOY NOT READY[^.]*report BLOCKED, do NOT roll back/, "id changed but not READY: BLOCKED, no rollback");
  assert.match(wait, /0 = DEPLOY READY[^.]*smoke check/);

  const smoke = find("- Production smoke check:");
  assert.match(commandOf(smoke), /bash scripts\/smoke-check\.sh$/);
  assert.match(smoke, /only after Production wait exited 0/i);
  assert.match(smoke, /600000 ms/);
  assert.match(smoke, /exit 0 = DONE/);
  assert.match(smoke, /HEALTH FAIL = Production rollback/);
  assert.match(smoke, /extra signal only/);

  const rollback = find("- Production rollback:");
  assert.match(rollback, /ONLY when BOTH hold: Production wait exited 0 \(the serving id changed and is READY\) AND Production smoke check printed HEALTH FAIL/);
  assert.match(rollback, /Never roll back when the wait exited 2 or 3[^.]*recorded id equals the serving id/);
  assert.match(rollback, /BLOCKED/);
  assert.match(rollback, /never choose another id/, "a refused id is BLOCKED");
  assert.match(rollback, /later merges to `main` do NOT go live until the owner[^.]*Undo Rollback/);

  const map = lines.join("\n");
  assert.match(map, /- How Edric's steps map \(agents\/edric\.md, read-only; edric\.md was aligned with this section by the customer's decision on 3 Nov 2026 \(Leto edited it\)\)/);
  assert.match(map, /edric\.md step 0[^\n]*Production previous deployment[^\n]*BEFORE the merge/);
  assert.match(map, /edric\.md step 2[^\n]*does not name the (Production )?checkout[^\n]*Production checkout[^\n]*after the merge[^\n]*before the smoke check/);
  assert.match(find("- Production previous deployment:"), /customer confirmed on 2 Nov 2026[^\n]*`npx vercel inspect rsvp\.kupernet\.com --json`[^\n]*`readyState` "READY"/);
  assert.match(map, /edric\.md step 2[^\n]*do not use `gh run list` or `gh run watch`[^\n]*Production wait/);
  assert.match(map, /edric\.md step 3[^\n]*Production smoke check, run only after Production wait exited 0/);
  assert.match(map, /edric\.md step 4[^\n]*stricter than "any failure"/);

  const order = lines.find((l) => l.startsWith("- Release order"));
  assert.ok(order, "the Release order line exists");
  const at = (s) => { const i = order.indexOf(s); assert.ok(i >= 0, `order mentions ${s}`); return i; };
  assert.ok(at("Production previous deployment") < at("merge (`gh pr merge`"), "previous deployment is recorded before the merge");
  assert.ok(at("merge (`gh pr merge`") < at("Production checkout"), "merge before checkout");
  assert.ok(at("Production checkout") < at("Production wait"), "checkout before wait");
  assert.ok(at("Production wait") < at("Production rollback"), "wait before rollback");
  const prev = find("- Production previous deployment:");
  assert.match(prev, /BEFORE the merge/);
  const checkout = find("- Production checkout:");
  assert.match(checkout, /AFTER the merge/);
  assert.match(checkout, /no longer to deploy/);
  assert.ok(at("Production wait") < at("Production smoke check") && at("Production smoke check") < at("Production rollback"), "wait, then smoke check, then rollback");
});

test("CLAUDE.md Stack line 11 describes the Git integration and has no deploy command", () => {
  const line = read("CLAUDE.md").split("\n").find((l) => l.startsWith("- **Deploy:**"));
  assert.ok(line, "the Stack Deploy line exists");
  const codeSpans = line.split("`").filter((_, i) => i % 2 === 1);
  assert.ok(codeSpans.length > 0 && !codeSpans.some((s) => /vercel\s+(--prod|deploy)/.test(s)), "no vercel --prod / vercel deploy command in a code span");
  assert.ok(!/^- \*\*Deploy:\*\* `/.test(line), "the line does not start with a command");
  assert.match(line, /Vercel Git integration \(PROPOSED/);
  assert.match(line, /github\.com\/muaddibbb\/rsvp-platform on 2 Nov 2026/);
  assert.match(line, /Ignored Build Step/);
  assert.match(line, /Do not run npx vercel --prod or vercel deploy/);
  assert.match(line, /see the Vercel settings/);
  const text = read("CLAUDE.md");
  assert.ok(!/as confirmed by the owner with `npx vercel project ls`/.test(text), "no unverified 'confirmed by the owner' claim");
  assert.match(text, /PROPOSED: seen in `npx vercel project ls` on 2026-11-02/);
});

test("smoke-check.sh supports --wait, stays GET-only and never requests /success with a slug", () => {
  const src = read("scripts/smoke-check.sh");
  assert.match(src, /--wait/);
  assert.match(src, /VERSION TIMEOUT/);
  for (const bad of [/(^|\s)-X(\s|$)/, /--request/, /--data/, /(^|\s)-d\s/, /POST/, /success\?/, /\/success\/[^"\s]/, /\/success\$/]) {
    assert.ok(!bad.test(src.replace(/^#.*$/gm, "")), `smoke-check.sh code matches ${bad}`);
  }
  assert.equal(spawnSync("bash", ["-n", path.join(ROOT, "scripts", "smoke-check.sh")]).status, 0);
});

// Offline test of the poll loop: a local http server answers every smoke-check URL. The version files are stale
// for the first `staleReads` reads of /index.html, then equal to this checkout's public/.
const http = require("node:http");
const { spawn } = require("node:child_process");

const os = require("node:os");

// Every child runs in its own process group, with a timeout, and is killed (whole group) when it ends, fails or the
// test process exits. Proxy variables are cleared so the "offline" stub traffic can never leave this machine.
const CLEAN_ENV = {
  http_proxy: "", https_proxy: "", all_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
};
const children = new Set();
const killGroup = (child) => { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { /* already gone */ } };
process.on("exit", () => { for (const c of children) killGroup(c); });

function runScript(script, args, env = {}, ms = 25000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", [path.join(ROOT, "scripts", script), ...args], {
      detached: true, env: { ...process.env, ...CLEAN_ENV, ...env },
    });
    children.add(child);
    let out = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, ms);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => {
      clearTimeout(timer); killGroup(child); children.delete(child);
      resolve({ code, out, timedOut, seconds: (Date.now() - started) / 1000 });
    });
  });
}
const runSmoke = (args, env = {}, ms) => runScript("smoke-check.sh", args, { SMOKE_POLL_INTERVAL: "1", ...env }, ms);
const T = { timeout: 40000 };

async function withStub(staleReads, run, { delay = 0 } = {}) {
  const methods = [];
  const paths = [];
  let indexReads = 0;
  const server = http.createServer((req, res0) => {
    const res = delay ? { writeHead: (...a) => res0.writeHead(...a), end: (b) => setTimeout(() => res0.end(b), delay) } : res0;
    methods.push(req.method); paths.push(req.url);
    const url = req.url.split("?")[0];
    const file = url.replace(/^\//, "");
    if (url === "/index.html") indexReads++;
    if (["index.html", "pricing.html", "rsvp.html", "style.css", "theme.js"].includes(file)) {
      res.writeHead(200);
      return res.end(indexReads > staleReads ? fs.readFileSync(path.join(ROOT, "public", file)) : "stale");
    }
    if (url.startsWith("/api/event/")) { res.writeHead(404); return res.end("{}"); }
    if (url === "/api/paypal-config") { res.writeHead(200); return res.end('{"clientId":"stub"}'); }
    res.writeHead(200); res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await run(`http://127.0.0.1:${server.address().port}`, { methods, paths }); }
  finally { server.close(); if (server.closeAllConnections) server.closeAllConnections(); }
}

test("smoke-check.sh --wait polls until VERSION MATCH, then runs the full checks (GET only)", T, async () => {
  await withStub(2, async (base, seen) => {
    const r = await runSmoke(["--wait", "20", base]);
    assert.ok(!r.timedOut, "no test timeout");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /wait: VERSION DIFFERENT/);
    assert.match(r.out, /wait: live files match this checkout/);
    assert.match(r.out, /HEALTH PASS/);
    assert.match(r.out, /VERSION MATCH/);
    assert.ok(seen.methods.length > 10 && seen.methods.every((m) => m === "GET"), "only GET requests");
    assert.ok(!seen.paths.some((p) => /^\/success[/?]/.test(p)), "never /success with a slug");
  });
});

test("smoke-check.sh --wait prints VERSION TIMEOUT and exits non-zero when the version never matches", T, async () => {
  await withStub(1e9, async (base, seen) => {
    const r = await runSmoke(["--wait", "2", base]);
    assert.ok(!r.timedOut, "no test timeout");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /VERSION TIMEOUT/);
    assert.match(r.out, /did not match this checkout \(unreachable, still building, or another version\)/);
    assert.ok(!/still serves/.test(r.out), "the message claims nothing about what production serves");
    assert.ok(!/HEALTH (PASS|FAIL)/.test(r.out), "no full checks after a timeout");
    assert.ok(seen.methods.every((m) => m === "GET"));
  });
});

test("smoke-check.sh --wait works after the base url, and an unreachable base times out within the bound", T, async () => {
  await withStub(0, async (base) => {
    const r = await runSmoke([base, "--wait", "5"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /wait: live files match/);
  });
  const r = await runSmoke(["--wait", "2", "http://127.0.0.1:9"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /VERSION TIMEOUT/);
  assert.ok(r.seconds < 20, `bounded run time, took ${r.seconds} s`);
});

test("smoke-check.sh stops at its overall deadline (SMOKE DEADLINE, exit 2) when answers are slow", T, async () => {
  await withStub(0, async (base) => {
    const r = await runSmoke([base], { SMOKE_DEADLINE: "2" });
    assert.ok(!r.timedOut, "no test timeout");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /SMOKE DEADLINE after 2 s/);
    assert.ok(r.seconds < 15, `bounded run time, took ${r.seconds} s`);
  }, { delay: 700 });
});

test("smoke-check.sh without --wait is unchanged: one pass, no polling", T, async () => {
  await withStub(1e9, async (base) => {
    const r = await runSmoke([base]);
    assert.equal(r.code, 1, r.out);
    assert.ok(!/wait:/.test(r.out) && !/VERSION TIMEOUT/.test(r.out));
    assert.match(r.out, /HEALTH PASS/);
    assert.match(r.out, /VERSION DIFFERENT/);
  });
  await withStub(0, async (base) => {
    const r = await runSmoke([base]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /VERSION MATCH/);
  });
});

test("smoke-check.sh validates --wait, the base url, extra arguments and its env knobs (usage, exit 64, no request)", T, async () => {
  await withStub(0, async (base, seen) => {
    const bad = [
      [["--wait", "abc"], {}], [["--wait", "0"], {}], [["--wait", "541"], {}], [["--wait", "007"], {}], [["--wait", ""], {}],
      [["--wait", "99999999999999999999"], {}], [["--wait"], {}], [[base, "--wait"], {}], [["--wait", "5", "--wait", "6", base], {}],
      [["--wait", "5", base, base], {}], [["-Kfoo/index.html"], {}], [["--wait", "5", "-x", base], {}],
      [["ftp://example.com"], {}], [["example.com"], {}], [["http://example.com"], {}],
      [["--wait", "5", base], { SMOKE_POLL_INTERVAL: "abc" }], [["--wait", "5", base], { SMOKE_POLL_INTERVAL: "0" }],
      [["--wait", "5", base], { SMOKE_POLL_INTERVAL: "61" }], [["--wait", "5", base], { SMOKE_POLL_INTERVAL: "" }],
      [["--wait", "5", base], { SMOKE_POLL_INTERVAL: "-1" }], [[base], { SMOKE_DEADLINE: "abc" }], [[base], { SMOKE_DEADLINE: "541" }],
    ];
    for (const [args, env] of bad) {
      const r = await runSmoke(args, env);
      assert.equal(r.code, 64, `${JSON.stringify(args)} ${JSON.stringify(env)}: ${r.out}`);
      assert.match(r.out, /usage/);
    }
    assert.equal(seen.methods.length, 0, "a rejected call makes no request");
    for (const interval of ["1", "60"]) {
      const r = await runSmoke(["--wait", "5", base], { SMOKE_POLL_INTERVAL: interval });
      assert.equal(r.code, 0, r.out);
    }
    const edge = await runSmoke(["--wait", "540", base]);
    assert.equal(edge.code, 0, edge.out);
  });
});

// wait-for-deploy.sh: the inspect command is replaced by an executable stub (WAIT_INSPECT_CMD). The stub answers the
// OLD id for the first `old` calls, then `newId` with `newState`; "fail" prints nothing and exits 1; "hang" sleeps.
function withInspectStub(mode, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-stub-"));
  const stub = path.join(dir, "inspect");
  fs.writeFileSync(stub, [
    "#!/usr/bin/env bash",
    'n=$(cat "$STUB_DIR/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$STUB_DIR/n"',
    '[ "${STUB_MODE:-}" = hang ] && exec sleep 60',
    '[ "${STUB_MODE:-}" = ignoreterm ] && { trap "" TERM; exec sleep 60; }',
    '[ "${STUB_MODE:-}" = noid ] && { echo \'{"readyState":"READY","target":"production"}\'; exit 0; }',
    '[ "${STUB_MODE:-}" = fail ] && exit 1',
    '[ "${STUB_MODE:-}" = garbage ] && { echo "not json"; exit 0; }',
    'if [ "$n" -le "${STUB_OLD:-0}" ]; then echo \'{"id":"dpl_old","readyState":"READY","target":"production"}\'; else echo "{\\"id\\":\\"${STUB_NEW_ID:-dpl_new}\\",\\"readyState\\":\\"${STUB_NEW_STATE:-READY}\\"}"; fi',
  ].join("\n") + "\n", { mode: 0o755 });
  const env = { WAIT_TEST_MODE: "1", WAIT_INSPECT_CMD: stub, STUB_DIR: dir, WAIT_POLL_INTERVAL: "1", STUB_MODE: mode.mode || "", ...mode.env };
  return Promise.resolve(run(env, () => Number(fs.readFileSync(path.join(dir, "n"), "utf8")))).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
const waitDeploy = (args, env, ms) => runScript("wait-for-deploy.sh", args, env, ms);

test("wait-for-deploy.sh: id changed and READY -> exit 0 (after the old id was served first)", T, () =>
  withInspectStub({ env: { STUB_OLD: "2" } }, async (env, calls) => {
    const r = await waitDeploy(["dpl_old", "30"], env);
    assert.ok(!r.timedOut);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /DEPLOY READY: id changed from dpl_old to dpl_new/);
    assert.ok(calls() >= 3, "it polled until the id changed");
  }));

test("wait-for-deploy.sh: id unchanged -> DEPLOY TIMEOUT, exit 2, BLOCKED, no rollback, check Vercel", T, () =>
  withInspectStub({ env: { STUB_OLD: "1000" } }, async (env) => {
    const r = await waitDeploy(["dpl_old", "3"], env);
    assert.ok(!r.timedOut);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /DEPLOY TIMEOUT after 3 s: the id did not change from dpl_old/);
    assert.match(r.out, /BLOCKED, no rollback/);
    assert.match(r.out, /Vercel dashboard/);
    assert.ok(!/still serves/.test(r.out));
    assert.ok(r.seconds < 15, `bounded, took ${r.seconds} s`);
  }));

test("wait-for-deploy.sh: id changed but not READY at the deadline -> DEPLOY NOT READY, exit 3, no rollback", T, () =>
  withInspectStub({ env: { STUB_OLD: "0", STUB_NEW_STATE: "BUILDING" } }, async (env) => {
    const r = await waitDeploy(["dpl_old", "3"], env);
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /DEPLOY NOT READY after 3 s: the id changed to dpl_new but readyState is BUILDING/);
    assert.match(r.out, /BLOCKED, no rollback/);
  }));

test("wait-for-deploy.sh: a new id with the old id passed as the new one is never READY (recorded id equals the serving id)", T, () =>
  withInspectStub({ env: { STUB_OLD: "0", STUB_NEW_ID: "dpl_old" } }, async (env) => {
    const r = await waitDeploy(["dpl_old", "3"], env);
    assert.equal(r.code, 2, r.out);
    assert.ok(!/DEPLOY READY/.test(r.out));
  }));

test("wait-for-deploy.sh: failing, garbage or hanging inspect -> exit 2 within the deadline, never READY", T, async () => {
  for (const mode of ["fail", "garbage", "hang"]) {
    await withInspectStub({ mode }, async (env) => {
      const r = await waitDeploy(["dpl_old", "3"], env, 30000);
      assert.ok(!r.timedOut, `${mode}: finished`);
      assert.equal(r.code, 2, `${mode}: ${r.out}`);
      assert.match(r.out, /DEPLOY TIMEOUT/);
      assert.ok(r.seconds < 15, `${mode}: bounded, took ${r.seconds} s`);
    });
  }
});

test("wait-for-deploy.sh: JSON without a usable id -> exit 2 (id unreadable), never exit 3 or READY", T, () =>
  withInspectStub({ mode: "noid" }, async (env) => {
    const r = await waitDeploy(["dpl_old", "3"], env);
    assert.ok(!r.timedOut);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /DEPLOY TIMEOUT/);
    assert.ok(!/DEPLOY READY|DEPLOY NOT READY|id READY/.test(r.out), r.out);
    assert.match(r.out, /no usable answer/);
  }));

test("wait-for-deploy.sh: an inspect command that ignores SIGTERM is killed (KILL) after a short grace", T, () =>
  withInspectStub({ mode: "ignoreterm" }, async (env) => {
    const r = await waitDeploy(["dpl_old", "3"], env, 30000);
    assert.ok(!r.timedOut);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /DEPLOY TIMEOUT/);
    assert.ok(r.seconds < 15, `bounded, took ${r.seconds} s (the stub sleeps 60 s)`);
  }));

test("wait-for-deploy.sh: an inherited WAIT_INSPECT_CMD without WAIT_TEST_MODE=1 is ignored (the real command runs)", T, () =>
  withInspectStub({ env: { STUB_OLD: "0" } }, async (env, calls) => {
    // a fake npx first in PATH records that the real command was chosen; the stub inspect would answer READY
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-npx-"));
    try {
      fs.writeFileSync(path.join(bin, "npx"), '#!/usr/bin/env bash\necho "$@" > "' + bin + '/called"\nexit 1\n', { mode: 0o755 });
      const r = await waitDeploy(["dpl_old", "3"], { ...env, WAIT_TEST_MODE: "", PATH: `${bin}${path.delimiter}${process.env.PATH}` });
      assert.equal(r.code, 2, r.out);
      assert.ok(!/DEPLOY READY/.test(r.out), r.out);
      assert.equal(fs.readFileSync(path.join(bin, "called"), "utf8").trim(), "vercel inspect rsvp.kupernet.com --json");
      assert.ok(!fs.existsSync(path.join(env.STUB_DIR, "n")), "the stub inspect was never run");
    } finally { fs.rmSync(bin, { recursive: true, force: true }); }
  }));

test("wait-for-deploy.sh validates its arguments and knobs (usage, exit 64)", T, async () => {
  const cases = [
    [[], {}], [["dpl_old"], {}], [["dpl_old", "5", "x"], {}], [["", "5"], {}], [["-x", "5"], {}], [["dpl old", "5"], {}], [["dpl;ls", "5"], {}],
    [["dpl_old", "0"], {}], [["dpl_old", "abc"], {}], [["dpl_old", "361"], {}], [["dpl_old", "007"], {}], [["dpl_old", "99999999999999999999"], {}],
    [["dpl_old", "5"], { WAIT_POLL_INTERVAL: "abc" }], [["dpl_old", "5"], { WAIT_POLL_INTERVAL: "0" }],
    [["dpl_old", "5"], { WAIT_POLL_INTERVAL: "61" }], [["dpl_old", "5"], { WAIT_POLL_INTERVAL: "" }],
  ];
  for (const [args, env] of cases) {
    const r = await waitDeploy(args, env);
    assert.equal(r.code, 64, `${JSON.stringify(args)} ${JSON.stringify(env)}: ${r.out}`);
    assert.match(r.out, /usage/);
  }
});

test("wait-for-deploy.sh is read-only: it only runs vercel inspect, never deploy, promote or rollback", () => {
  const file = path.join(ROOT, "scripts", "wait-for-deploy.sh");
  assert.equal(spawnSync("bash", ["-n", file], { encoding: "utf8" }).status, 0);
  const code = fs.readFileSync(file, "utf8").replace(/^\s*#.*$/gm, "");
  const vercel = [...code.matchAll(/vercel\s+(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(vercel, ["inspect"], "the only vercel subcommand is inspect");
  for (const bad of [/--prod/, /\bpromote\b/, /\brollback\b/, /\bdeploy\b(?!-)/, /\bcurl\b/, /\bgit\b/, /\bgh\b/]) {
    assert.ok(!bad.test(code.replace(/echo "[^"]*"/g, "")), `wait-for-deploy.sh code matches ${bad}`);
  }
});

test("gitignore and vercelignore keep run folders and env files out", () => {
  const lines = (rel) => read(rel).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(lines(".gitignore").includes(".atreides/"));
  const v = lines(".vercelignore");
  for (const need of [".atreides", ".env", ".env.*"]) assert.ok(v.includes(need), `.vercelignore has ${need}`);
  for (const bad of ["public", "api", "vercel.json", "tests", "tests/"]) assert.ok(!v.includes(bad), `.vercelignore must not list ${bad}`);
});
