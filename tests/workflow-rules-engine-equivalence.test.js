// The n8n workflow runs its OWN inline copy of the rules engine (node "Rules Engine"); the documented
// source of truth is automation/rules-engine.js. This test proves the two stay behaviourally identical.
//
// Method (different from a plain "random inputs through two functions" fuzz):
//   1. Both implementations are executed through the SAME n8n-style harness: the code text is wrapped in
//      a function with a fake `$input`, so top-level `return` and the `$input` entry path are exercised
//      for the file as well as for the embedded node.
//   2. Inputs come from (a) an exhaustive boundary grid and (b) a seeded PRNG (mulberry32), including
//      missing / undefined fields.
//   3. Everything is compared (budgetStatus, projection, CPA, profitable, winners, candidateActions,
//      droppedActions, config, note COUNT) except the human-readable `reason` / `notes` TEXT, which differs by design.
//   4. A sensitivity control mutates the embedded source in memory and asserts the comparison DOES detect
//      the divergence, so a green run cannot be a harness that compares nothing.
// No network, no dependencies, no project files are modified.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const filePath = path.join(ROOT, "automation", "rules-engine.js");
const wfPath = path.join(ROOT, "automation", "campaign-manager.workflow.json");

const fileSrc = fs.readFileSync(filePath, "utf8");
const wf = JSON.parse(fs.readFileSync(wfPath, "utf8"));
const embeddedSrc = wf.nodes.find((n) => n.name === "Rules Engine").parameters.jsCode;

function n8nRunner(src) {
  const fn = new Function("$input", "module", src);
  return (data) => {
    const out = fn({ first: () => ({ json: data }) }, { exports: {} });
    assert.ok(Array.isArray(out) && out.length === 1, "code node must return a one-item array");
    return out[0].json;
  };
}

// Strip the fields that differ by design; keep their structure/counts.
function normalise(o) {
  return {
    ...o,
    notes: o.notes.length,
    candidateActions: o.candidateActions.map(({ reason, ...rest }) => rest),
  };
}

const runFile = n8nRunner(fileSrc);
const runEmbedded = n8nRunner(embeddedSrc);
const { decide } = require(filePath);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── grid ─────────────────────────────────────────────────────────────────────
const MTDS = [0, 1, 99.99, 100, 299.99, 300, 387, 399, 399.99, 400, 400.01, 800, undefined];
const DAYS = [[1, 28], [1, 30], [1, 31], [15, 30], [20, 30], [27, 31], [28, 28], [30, 30], [31, 31], [undefined, undefined], [35, 30]];
const BUDGETS = [undefined, 0, 1, 5, 9, 12, 12.4, 12.5, 13, 13.4, 13.5, 14, 20, 1000];
const STATUSES = ["ENABLED", "PAUSED", "REMOVED", undefined];

const KW_SETS = [
  [],
  [{ criterionId: "k1", text: "a", matchType: "PHRASE", status: "ENABLED", costILS: 60, conversions: 0, conversionsAllTime: 0, clicks: 9 }],
  [{ criterionId: "k1", text: "a", matchType: "PHRASE", status: "ENABLED", costILS: 59.99, conversions: 0, conversionsAllTime: 0 }],
  [{ criterionId: "k1", text: "a", matchType: "EXACT", status: "ENABLED", costILS: 90, conversions: 0, conversionsAllTime: 3 }],
  [{ criterionId: "k1", text: "a", matchType: "EXACT", status: "ENABLED", costILS: 90, conversions: 2, conversionsAllTime: 2 }],
  [{ criterionId: "k1", text: "a", matchType: "EXACT", status: "PAUSED", costILS: 90, conversions: 0, conversionsAllTime: 0 }],
  [{ text: "bare", status: "ENABLED" }],
];
const ST_SETS = [
  [],
  [{ term: "a", clicks: 9, costILS: 99, conversions: 0, alreadyNegative: false }], // equals keyword text "a"
  [{ term: "x", clicks: 4, costILS: 15, conversions: 0, alreadyNegative: false }],
  [{ term: "x", clicks: 3, costILS: 15, conversions: 0, alreadyNegative: false }],
  [{ term: "x", clicks: 4, costILS: 14.99, conversions: 0, alreadyNegative: false }],
  [{ term: "x", clicks: 9, costILS: 50, conversions: 1, alreadyNegative: false }],
  [{ term: "x", clicks: 9, costILS: 50, conversions: 0, alreadyNegative: true }],
  [{ term: "x", clicks: 9, costILS: 50 }, { term: "x", clicks: 9, costILS: 50 }, { term: "y", clicks: 5, costILS: 20 }],
];

function* grid() {
  let counter = 0; // local, so every call to grid() yields the identical sequence
  for (const mtd of MTDS)
    for (const [d, dim] of DAYS)
      for (const b of BUDGETS)
        for (const s of STATUSES) {
          // vary keyword / search-term sets deterministically without a full cartesian blow-up
          const i = ++counter;
          yield {
            campaign: { name: "RSVP Search Campaign", status: s, dailyBudgetILS: b, costILS: i % 5 === 0 ? 300 : 0, conversions: i % 7 === 0 ? 4 : 0 },
            keywords: KW_SETS[i % KW_SETS.length],
            searchTerms: ST_SETS[i % ST_SETS.length],
            monthToDateSpendILS: mtd,
            dayOfMonth: d,
            daysInMonth: dim,
          };
        }
}

test("boundary grid: embedded node == standalone file (n8n harness) == module.exports decide()", () => {
  let n = 0;
  for (const input of grid()) {
    n++;
    const f = normalise(runFile(structuredClone(input)));
    const e = normalise(runEmbedded(structuredClone(input)));
    const m = normalise(decide(structuredClone(input)));
    assert.deepStrictEqual(e, f, `embedded != file for ${JSON.stringify(input)}`);
    assert.deepStrictEqual(m, f, `module.exports != $input path for ${JSON.stringify(input)}`);
  }
  assert.ok(n > 5000, `grid unexpectedly small: ${n}`);
});

// ── seeded random ────────────────────────────────────────────────────────────
function randomInput(rnd) {
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const num = (lo, hi) => Math.round((lo + rnd() * (hi - lo)) * 100) / 100;
  const maybe = (v) => (rnd() < 0.08 ? undefined : v);
  const dim = pick([28, 29, 30, 31]);
  const nk = Math.floor(rnd() * 12);
  const nt = Math.floor(rnd() * 14);
  const texts = Array.from({ length: 8 }, (_, i) => "t" + i);
  return {
    campaign: { name: "c", status: pick(["ENABLED", "PAUSED", "REMOVED"]), dailyBudgetILS: maybe(rnd() < 0.5 ? pick([1, 5, 9, 12, 13, 14, 20]) : num(0, 30)), costILS: maybe(num(0, 600)), conversions: maybe(pick([0, 0, 1, 3, 7])) },
    keywords: Array.from({ length: nk }, (_, i) => ({
      criterionId: "id" + i, text: pick(texts), matchType: pick(["PHRASE", "EXACT", "BROAD"]), status: pick(["ENABLED", "ENABLED", "PAUSED"]),
      costILS: maybe(rnd() < 0.3 ? pick([59.99, 60, 60.01]) : num(0, 200)), conversions: maybe(pick([0, 0, 0, 1, 2])), clicks: maybe(Math.floor(rnd() * 30)), conversionsAllTime: maybe(pick([0, 0, 0, 1, 4])),
    })),
    searchTerms: Array.from({ length: nt }, () => ({
      term: pick(texts.concat(["x", "y", "z"])), clicks: maybe(rnd() < 0.3 ? pick([3, 4, 5]) : Math.floor(rnd() * 20)), costILS: maybe(rnd() < 0.3 ? pick([14.99, 15, 15.01]) : num(0, 80)),
      conversions: maybe(pick([0, 0, 0, 1])), alreadyNegative: rnd() < 0.2,
    })),
    monthToDateSpendILS: maybe(rnd() < 0.2 ? pick([0, 399.99, 400, 400.01]) : num(0, 520)),
    dayOfMonth: maybe(1 + Math.floor(rnd() * dim)),
    daysInMonth: maybe(dim),
  };
}

for (const seed of [0x5eed1234, 0xc0ffee, 20261101]) {
  test(`seeded random (mulberry32 seed ${seed.toString(16)}): 15,000 inputs, 0 differences`, () => {
    const rnd = mulberry32(seed);
    let diffs = 0;
    for (let i = 0; i < 15000; i++) {
      const input = randomInput(rnd);
      const f = normalise(runFile(structuredClone(input)));
      const e = normalise(runEmbedded(structuredClone(input)));
      try {
        assert.deepStrictEqual(e, f);
      } catch (err) {
        diffs++;
        if (diffs === 1) assert.fail(`first difference at i=${i}: ${JSON.stringify(input)}\n${err.message}`);
      }
    }
    assert.equal(diffs, 0);
  });
}

test("both copies carry the same CONFIG values", () => {
  const input = { campaign: { status: "ENABLED", dailyBudgetILS: 13 } };
  assert.deepStrictEqual(runEmbedded(structuredClone(input)).config, runFile(structuredClone(input)).config);
});

// ── sensitivity control: the comparison must notice a real behavioural change ─
const MUTATIONS = [
  ["cap constant 400 -> 401", (s) => s.replace("MONTHLY_BUDGET_CAP_ILS: 400", "MONTHLY_BUDGET_CAP_ILS: 401")],
  ["keyword spend threshold >= -> >", (s) => s.replace("(k.costILS || 0) >= CONFIG.KEYWORD_PAUSE_MIN_SPEND_ILS", "(k.costILS || 0) > CONFIG.KEYWORD_PAUSE_MIN_SPEND_ILS")],
  ["resume on PAUSED -> on REMOVED", (s) => s.replace("campaign.status === 'PAUSED'", "campaign.status === 'REMOVED'")],
  ["action cap 8 -> 7", (s) => s.replace("MAX_ACTIONS_PER_RUN: 8", "MAX_ACTIONS_PER_RUN: 7")],
  ["negatives ignore keyword protection", (s) => s.replace("&& !keywordTexts.has(t.term)", "")],
  ["keyword actions off", (s) => s.replace("ENABLE_KEYWORD_ACTIONS: true", "ENABLE_KEYWORD_ACTIONS: false")],
];

for (const [name, mutate] of MUTATIONS) {
  test(`sensitivity control: mutating the embedded copy (${name}) is detected`, () => {
    const mutatedSrc = mutate(embeddedSrc);
    assert.notEqual(mutatedSrc, embeddedSrc, "mutation did not apply (pattern drifted) - update the control");
    const runMutated = n8nRunner(mutatedSrc);
    let detected = false;
    for (const input of grid()) {
      const f = normalise(runFile(structuredClone(input)));
      const e = normalise(runMutated(structuredClone(input)));
      try { assert.deepStrictEqual(e, f); } catch { detected = true; break; }
    }
    assert.ok(detected, `mutation "${name}" was NOT detected by the grid - the comparison is too weak`);
  });
}
