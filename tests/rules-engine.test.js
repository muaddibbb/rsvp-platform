// Behaviour tests for decide() in automation/rules-engine.js (the Google Ads guardrail engine).
// Pure function, no network, no dependencies. Run: node --test /Users/rkuperman/rsvp-platform/tests/*.test.js
//
// Tests labelled "KNOWN WEAKNESS" pin down CURRENT behaviour that the integrity review (J-15, J-16,
// J-17) flagged as undesirable. They are here so the behaviour is documented and so a deliberate fix
// shows up as a test change rather than a silent difference. If you fix the engine, update them.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ENGINE_PATH = path.resolve(__dirname, "..", "automation", "rules-engine.js");
const { decide, CONFIG } = require(ENGINE_PATH);

function input(over = {}) {
  return {
    campaign: { name: "RSVP Search Campaign", status: "ENABLED", dailyBudgetILS: 13, costILS: 0, conversions: 0, ...(over.campaign || {}) },
    keywords: over.keywords || [],
    searchTerms: over.searchTerms || [],
    monthToDateSpendILS: over.monthToDateSpendILS ?? 0,
    dayOfMonth: over.dayOfMonth ?? 1,
    daysInMonth: over.daysInMonth ?? 30,
    pausedByAgent: over.pausedByAgent,
  };
}
const kw = (o) => ({ criterionId: "c/" + o.text, matchType: "PHRASE", status: "ENABLED", costILS: 0, conversions: 0, clicks: 0, conversionsAllTime: 0, ...o });
const st = (o) => ({ clicks: 0, costILS: 0, conversions: 0, alreadyNegative: false, ...o });
const types = (r) => r.candidateActions.map((a) => a.type);

function withKeywordActions(value, fn) {
  const prev = CONFIG.ENABLE_KEYWORD_ACTIONS;
  CONFIG.ENABLE_KEYWORD_ACTIONS = value;
  try { return fn(); } finally { CONFIG.ENABLE_KEYWORD_ACTIONS = prev; }
}

// ── entry paths ──────────────────────────────────────────────────────────────
test("entry path 1: module.exports exposes decide and CONFIG; requiring the file in Node does not execute the n8n branch", () => {
  assert.equal(typeof decide, "function");
  assert.equal(CONFIG.MONTHLY_BUDGET_CAP_ILS, 400);
  assert.equal(CONFIG.DAILY_BUDGET_ILS, 13);
  assert.equal(CONFIG.MAX_ACTIONS_PER_RUN, 8);
  assert.equal(typeof globalThis.$input, "undefined");
});

test("entry path 2: with an n8n-style $input the file returns [{json: decide(...)}] (top-level return)", () => {
  const src = fs.readFileSync(ENGINE_PATH, "utf8");
  const run = new Function("$input", "module", src); // n8n wraps Code-node bodies in a function the same way
  const data = input({ monthToDateSpendILS: 300, dayOfMonth: 20 });
  const out = run({ first: () => ({ json: data }) }, { exports: {} });
  assert.ok(Array.isArray(out) && out.length === 1 && out[0].json, "expected [{json}]");
  assert.deepEqual(out[0].json.candidateActions, decide(data).candidateActions);
  assert.equal(out[0].json.budgetStatus, "throttling");
});

test("entry path 2b: without $input the same source falls through to module.exports", () => {
  const src = fs.readFileSync(ENGINE_PATH, "utf8");
  const mod = { exports: {} };
  const ret = new Function("module", src)(mod);
  assert.equal(ret, undefined);
  assert.equal(typeof mod.exports.decide, "function");
});

// ── budget guardrails ────────────────────────────────────────────────────────
test("below budget: day 1, MTD 0, budget 13 -> ok, projected 390, no actions", () => {
  const r = decide(input());
  assert.equal(r.budgetStatus, "ok");
  assert.equal(r.projectedMonthILS, 390);
  assert.deepEqual(r.candidateActions, []);
  assert.equal(r.droppedActions, 0);
});

test("throttling: MTD 300 on day 20 of 30 -> set_daily_budget floor(100/11)=9", () => {
  const r = decide(input({ monthToDateSpendILS: 300, dayOfMonth: 20 }));
  assert.equal(r.budgetStatus, "throttling");
  assert.equal(r.projectedMonthILS, 443);
  assert.deepEqual(r.candidateActions.map((a) => [a.type, a.valueILS]), [["set_daily_budget", 9]]);
});

test("throttling: no action is emitted when the budget already equals the safe value", () => {
  const r = decide(input({ monthToDateSpendILS: 300, dayOfMonth: 20, campaign: { dailyBudgetILS: 9 } }));
  assert.equal(r.budgetStatus, "throttling");
  assert.deepEqual(r.candidateActions, []);
});

test("throttling: the throttled value never drops below 1", () => {
  const r = decide(input({ monthToDateSpendILS: 399, dayOfMonth: 29, daysInMonth: 30 }));
  assert.equal(r.budgetStatus, "throttling");
  assert.equal(r.candidateActions[0].valueILS, 1);
});

test("cap reached: MTD exactly 400 -> pause_campaign, status cap_reached, note present", () => {
  const r = decide(input({ monthToDateSpendILS: 400 }));
  assert.equal(r.budgetStatus, "cap_reached");
  assert.deepEqual(types(r), ["pause_campaign"]);
  assert.ok(r.notes.some((n) => /cap reached/i.test(n)));
});

test("cap boundary: MTD 399.99 is not the cap (throttle instead), 400.01 is", () => {
  assert.equal(decide(input({ monthToDateSpendILS: 399.99, dayOfMonth: 15 })).budgetStatus, "throttling");
  assert.equal(decide(input({ monthToDateSpendILS: 400.01 })).budgetStatus, "cap_reached");
});

test("budget above 13 with no throttle -> set_daily_budget 13; budget exactly 13 -> nothing", () => {
  const r = decide(input({ campaign: { dailyBudgetILS: 20 } }));
  assert.deepEqual(r.candidateActions.map((a) => [a.type, a.valueILS]), [["set_daily_budget", 13]]);
  assert.deepEqual(decide(input({ campaign: { dailyBudgetILS: 13 } })).candidateActions, []);
});

// ── pause / resume ───────────────────────────────────────────────────────────
test("paused BY THE AGENT under the cap -> resume_campaign", () => {
  const r = decide(input({ campaign: { status: "PAUSED" }, monthToDateSpendILS: 0, pausedByAgent: true }));
  assert.deepEqual(types(r), ["resume_campaign"]);
});

// Deliberate change of an earlier expectation (was: "pause_campaign only, NO resume"): a campaign that is
// already paused is not paused a second time (a repeated API pause would make a hand pause look like the
// agent's own in the change history).
test("paused campaign at/over the cap -> no second pause, no resume", () => {
  const r = decide(input({ campaign: { status: "PAUSED" }, monthToDateSpendILS: 450 }));
  assert.deepEqual(r.candidateActions, []);
  assert.equal(r.budgetStatus, "cap_reached");
  assert.ok(r.notes.some((n) => /cap reached/i.test(n)));
});

test("an ENABLED campaign at the cap is still paused", () => {
  const r = decide(input({ campaign: { status: "ENABLED" }, monthToDateSpendILS: 450 }));
  assert.deepEqual(types(r), ["pause_campaign"]);
});

test("paused + throttling -> throttle then resume (budget actions come first)", () => {
  const r = decide(input({ campaign: { status: "PAUSED" }, monthToDateSpendILS: 300, dayOfMonth: 20, pausedByAgent: true }));
  assert.deepEqual(types(r), ["set_daily_budget", "resume_campaign"]);
});

test("a campaign paused by hand is NOT resumed and a note says so", () => {
  for (const pausedByAgent of [false, undefined]) {
    const r = decide(input({ campaign: { status: "PAUSED" }, monthToDateSpendILS: 120, dayOfMonth: 10, pausedByAgent }));
    assert.ok(!types(r).includes("resume_campaign"), String(pausedByAgent));
    assert.ok(r.notes.some((n) => /not resuming/i.test(n)), "note: " + String(pausedByAgent));
  }
});

test("only a strict true resumes (the strings 'true' and the number 1 do not)", () => {
  for (const pausedByAgent of ["true", 1, "yes", {}, null]) {
    const r = decide(input({ campaign: { status: "PAUSED" }, monthToDateSpendILS: 0, pausedByAgent }));
    assert.ok(!types(r).includes("resume_campaign"), String(pausedByAgent));
  }
  assert.ok(types(decide(input({ campaign: { status: "PAUSED" }, monthToDateSpendILS: 0, pausedByAgent: true }))).includes("resume_campaign"));
});

test("KNOWN WEAKNESS (J-17): an empty MTD read (0) on a cap-paused campaign looks like a new month and resumes", () => {
  const r = decide(input({ campaign: { status: "PAUSED" }, monthToDateSpendILS: 0, dayOfMonth: 20, pausedByAgent: true }));
  assert.ok(types(r).includes("resume_campaign"));
});

test("PAUSED is the only status that resumes (ENABLED / REMOVED / undefined do not)", () => {
  for (const status of ["ENABLED", "REMOVED", undefined]) assert.ok(!types(decide(input({ campaign: { status }, pausedByAgent: true }))).includes("resume_campaign"), String(status));
});

test("CONFIG.DAILY_BUDGET_ILS is 13 in the engine and in the inline copy", () => {
  assert.equal(CONFIG.DAILY_BUDGET_ILS, 13);
  const wf = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "automation", "campaign-manager.workflow.json"), "utf8"));
  const inline = wf.nodes.find((n) => n.name === "Rules Engine").parameters.jsCode;
  assert.match(inline, /DAILY_BUDGET_ILS:\s*13\b/);
});

// ── month length (J-15) ──────────────────────────────────────────────────────
test("KNOWN WEAKNESS (J-15): a 31-day month throttles to 12 on day 1 (13 x 31 = 403 > 400)", () => {
  const r = decide(input({ daysInMonth: 31 }));
  assert.equal(r.budgetStatus, "throttling");
  assert.equal(r.projectedMonthILS, 403);
  assert.deepEqual(r.candidateActions.map((a) => [a.type, a.valueILS]), [["set_daily_budget", 12]]);
});

test("KNOWN WEAKNESS (J-15): nothing raises the budget back up after a throttle (budget 5, MTD 0, 30-day month -> ok, no action)", () => {
  const r = decide(input({ campaign: { dailyBudgetILS: 5 } }));
  assert.equal(r.budgetStatus, "ok");
  assert.deepEqual(r.candidateActions, []);
});

// ── keyword actions ──────────────────────────────────────────────────────────
test("loser keyword (ENABLED, 0 conv 30d, 0 lifetime, cost >= 60) -> pause_keyword, biggest spender first", () => {
  const r = decide(input({ keywords: [kw({ text: "a", costILS: 61 }), kw({ text: "b", costILS: 90 }), kw({ text: "c", costILS: 60 })] }));
  assert.deepEqual(r.candidateActions.map((a) => [a.type, a.keyword]), [["pause_keyword", "b"], ["pause_keyword", "a"], ["pause_keyword", "c"]]);
  assert.equal(r.candidateActions[0].criterionId, "c/b");
});

test("loser keyword WITH all-time conversions is protected and listed as a winner", () => {
  const r = decide(input({ keywords: [kw({ text: "w", costILS: 200, conversions: 0, conversionsAllTime: 2 })] }));
  assert.deepEqual(r.candidateActions, []);
  assert.deepEqual(r.winners.map((w) => w.keyword), ["w"]);
  assert.equal(r.winners[0].cpaILS, null); // no 30-day conversions -> no CPA
});

test("keyword protection edges: 59.99 spend, 30d conversion, PAUSED status, missing fields -> not paused", () => {
  const r = decide(input({ keywords: [
    kw({ text: "cheap", costILS: 59.99 }),
    kw({ text: "converted", costILS: 100, conversions: 1 }),
    kw({ text: "paused", costILS: 100, status: "PAUSED" }),
    { text: "bare", status: "ENABLED" },
  ] }));
  assert.deepEqual(r.candidateActions, []);
});

test("winner CPA is cost / 30-day conversions, rounded", () => {
  const r = decide(input({ keywords: [kw({ text: "w", costILS: 100, conversions: 3, conversionsAllTime: 3 })] }));
  assert.equal(r.winners[0].cpaILS, 33);
});

// ── search terms ─────────────────────────────────────────────────────────────
test("search term with >=4 clicks, >=15 spend, 0 conversions, not negative -> add_negative PHRASE, biggest spend first", () => {
  const r = decide(input({ searchTerms: [st({ term: "x", clicks: 4, costILS: 15 }), st({ term: "y", clicks: 9, costILS: 40 })] }));
  assert.deepEqual(r.candidateActions.map((a) => [a.type, a.text, a.matchType]), [["add_negative", "y", "PHRASE"], ["add_negative", "x", "PHRASE"]]);
});

test("search term thresholds: 3 clicks, 14.99 spend, a conversion, alreadyNegative -> excluded", () => {
  const r = decide(input({ searchTerms: [
    st({ term: "few", clicks: 3, costILS: 50 }),
    st({ term: "cheap", clicks: 9, costILS: 14.99 }),
    st({ term: "conv", clicks: 9, costILS: 50, conversions: 1 }),
    st({ term: "done", clicks: 9, costILS: 50, alreadyNegative: true }),
  ] }));
  assert.deepEqual(r.candidateActions, []);
});

test("search term EXACTLY equal to a keyword's text is never negated (even a keyword with no activity)", () => {
  const r = decide(input({
    keywords: [kw({ text: "אישורי הגעה", costILS: 5 })],
    searchTerms: [st({ term: "אישורי הגעה", clicks: 10, costILS: 80 })],
  }));
  assert.deepEqual(r.candidateActions, []);
});

test("KNOWN WEAKNESS (J-16/G-A5): a term that is a SUB-PHRASE of a converting keyword IS proposed as a PHRASE negative", () => {
  const r = decide(input({
    keywords: [kw({ text: "AB CD", costILS: 50, conversions: 1, conversionsAllTime: 1 })],
    searchTerms: [st({ term: "AB", clicks: 6, costILS: 20 })],
  }));
  assert.deepEqual(r.candidateActions.map((a) => [a.type, a.text]), [["add_negative", "AB"]]);
});

test("KNOWN WEAKNESS (J-16/G-A4): duplicate rows for one term (one per ad group) yield duplicate negatives", () => {
  const r = decide(input({ searchTerms: [st({ term: "dup", clicks: 5, costILS: 20 }), st({ term: "dup", clicks: 5, costILS: 20 })] }));
  assert.equal(r.candidateActions.filter((a) => a.text === "dup").length, 2);
});

// ── switches and limits ──────────────────────────────────────────────────────
test("ENABLE_KEYWORD_ACTIONS=false removes keyword pauses and negatives but keeps budget actions", () => {
  const data = input({
    campaign: { dailyBudgetILS: 20 },
    keywords: [kw({ text: "loser", costILS: 100 })],
    searchTerms: [st({ term: "waste", clicks: 9, costILS: 40 })],
  });
  assert.deepEqual(types(withKeywordActions(true, () => decide(data))), ["set_daily_budget", "pause_keyword", "add_negative"]);
  assert.deepEqual(types(withKeywordActions(false, () => decide(data))), ["set_daily_budget"]);
});

test("ENABLE_KEYWORD_ACTIONS=false still reports winners", () => {
  const r = withKeywordActions(false, () => decide(input({ keywords: [kw({ text: "w", conversionsAllTime: 1 })] })));
  assert.equal(r.winners.length, 1);
});

test("MAX_ACTIONS_PER_RUN: 12 candidates are cut to 8, budget action first, droppedActions = 5 (13 total)", () => {
  const keywords = Array.from({ length: 6 }, (_, i) => kw({ text: "k" + i, costILS: 100 + i }));
  const searchTerms = Array.from({ length: 6 }, (_, i) => st({ term: "t" + i, clicks: 9, costILS: 30 + i }));
  const r = decide(input({ campaign: { dailyBudgetILS: 20 }, keywords, searchTerms }));
  assert.equal(r.candidateActions.length, CONFIG.MAX_ACTIONS_PER_RUN);
  assert.equal(r.candidateActions[0].type, "set_daily_budget");
  assert.equal(r.droppedActions, 13 - 8);
  // keyword pauses precede negatives, so the last candidates (negatives) are the ones dropped
  assert.equal(r.candidateActions.filter((a) => a.type === "pause_keyword").length, 6);
  assert.equal(r.candidateActions.filter((a) => a.type === "add_negative").length, 1);
});

test("a pause_campaign is first in the list even when many keyword actions exist (so truncation cannot drop it)", () => {
  const keywords = Array.from({ length: 20 }, (_, i) => kw({ text: "k" + i, costILS: 100 }));
  const r = decide(input({ monthToDateSpendILS: 500, keywords }));
  assert.equal(r.candidateActions[0].type, "pause_campaign");
  assert.equal(r.candidateActions.length, 8);
});

// ── bad / missing input (NaN path, J-17) ─────────────────────────────────────
test("KNOWN WEAKNESS (J-17): missing dailyBudgetILS + throttling -> still emits a set_daily_budget (NaN !== safeDaily)", () => {
  const r = decide(input({ campaign: { dailyBudgetILS: undefined }, monthToDateSpendILS: 300, dayOfMonth: 20 }));
  assert.deepEqual(r.candidateActions.map((a) => [a.type, a.valueILS]), [["set_daily_budget", 9]]);
});

test("missing dailyBudgetILS with no throttle -> no budget action (NaN > 13 is false)", () => {
  assert.deepEqual(decide(input({ campaign: { dailyBudgetILS: undefined } })).candidateActions, []);
});

test("a missing campaign object throws (the engine does not guard against it)", () => {
  assert.throws(() => decide({ monthToDateSpendILS: 0 }), TypeError);
});

test("omitted optional inputs default sensibly (no keywords, no search terms, day 1, 30 days, MTD 0)", () => {
  const r = decide({ campaign: { dailyBudgetILS: 13, status: "ENABLED" } });
  assert.equal(r.budgetStatus, "ok");
  assert.equal(r.projectedMonthILS, 390);
});

test("CPA and profitability: 300 cost / 4 conversions = 75 < 99 -> profitable with a note; 400/2 = 200 -> not", () => {
  const good = decide(input({ campaign: { costILS: 300, conversions: 4 } }));
  assert.equal(good.cpaILS, 75);
  assert.equal(good.profitable, true);
  assert.ok(good.notes.some((n) => /profitable/i.test(n)));
  const bad = decide(input({ campaign: { costILS: 400, conversions: 2 } }));
  assert.equal(bad.cpaILS, 200);
  assert.equal(bad.profitable, false);
  assert.equal(decide(input()).cpaILS, null);
});

test("decide() does not mutate its input", () => {
  const data = input({ monthToDateSpendILS: 300, dayOfMonth: 20, keywords: [kw({ text: "k", costILS: 90 })], searchTerms: [st({ term: "t", clicks: 9, costILS: 40 })] });
  const before = JSON.stringify(data);
  decide(data);
  assert.equal(JSON.stringify(data), before);
});
