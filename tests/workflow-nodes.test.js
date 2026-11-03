// Behaviour tests for the other Code nodes of automation/campaign-manager.workflow.json
// (Normalize, Validate & Gate, Gate: mutations, Gate: website proposal, Build LLM request),
// executed offline with a fake n8n context ($input, $). No network, no dependencies.
// "KNOWN WEAKNESS" tests pin down current behaviour flagged in the integrity review (J-14, J-17, J-25).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wf = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "automation", "campaign-manager.workflow.json"), "utf8"));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const code = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  assert.ok(n, `node ${name} missing`);
  return n.parameters.jsCode;
};

// Run a Code node. `upstream` maps node name -> json (what $('Name').first().json returns).
async function run(name, { input = {}, upstream = {} } = {}) {
  const fn = new AsyncFunction("$input", "$", code(name));
  const out = await fn({ first: () => ({ json: input }) }, (n) => {
    if (!(n in upstream)) throw new Error(`upstream node "${n}" not provided`);
    return { first: () => ({ json: upstream[n] }) };
  });
  return out;
}

// ── Validate & Gate ──────────────────────────────────────────────────────────
const budgetAct = { type: "set_daily_budget", valueILS: 9, reason: "r" };
const pauseCamp = { type: "pause_campaign", reason: "cap" };
const pauseKw = { type: "pause_keyword", criterionId: "customers/1/adGroupCriteria/2~3", keyword: "kw", matchType: "PHRASE", reason: "r" };
const neg = { type: "add_negative", text: "bad term", matchType: "PHRASE", reason: "r" };
const baseEngine = (over = {}) => ({
  budgetStatus: "throttling", monthToDateSpendILS: 300, projectedMonthILS: 443, cpaILS: null, profitable: false, winners: [],
  candidateActions: [budgetAct, pauseKw, neg], droppedActions: 0, config: { DAILY_BUDGET_ILS: 13 }, notes: [], ...over,
});
const norm = { campaign: { resourceName: "customers/1/campaigns/7", budgetResourceName: "customers/1/campaignBudgets/8" } };
const llm = (obj) => ({ message: { content: typeof obj === "string" ? obj : JSON.stringify(obj) } });

async function validate(engine, llmOutput) {
  const [{ json }] = await run("Validate & Gate", { input: llmOutput, upstream: { "Rules Engine": engine, Normalize: norm } });
  return json;
}

test("Validate: LLM approves exactly the engine's actions -> all pass through, as the ENGINE's copies", async () => {
  const out = await validate(baseEngine(), llm({ approvedActions: [{ ...budgetAct, reason: "LLM wording" }, pauseKw, neg], summary: "ok" }));
  assert.equal(out.approvedCount, 3);
  assert.equal(out.summary, "ok");
  assert.equal(out.mutations.length, 3);
  assert.deepEqual(out.mutations.map((m) => m.label), ["budget: ₪9/day", "pause: kw", "negative: bad term"]);
});

test("Validate: an INVENTED action is dropped", async () => {
  const out = await validate(baseEngine(), llm({ approvedActions: [{ type: "add_negative", text: "invented", matchType: "PHRASE" }, budgetAct] }));
  assert.equal(out.approvedCount, 1);
  assert.deepEqual(out.mutations.map((m) => m.label), ["budget: ₪9/day"]);
});

test("Validate: an action with an ALTERED valueILS is dropped (cannot raise the budget)", async () => {
  const out = await validate(baseEngine(), llm({ approvedActions: [{ type: "set_daily_budget", valueILS: 500 }] }));
  assert.equal(out.approvedCount, 0);
  assert.deepEqual(out.mutations, []);
});

test("Validate: pausing a WINNER keyword is dropped even if the engine (wrongly) sanctioned it", async () => {
  const engine = baseEngine({ candidateActions: [pauseKw], winners: [{ keyword: "kw", matchType: "PHRASE", cpaILS: 50 }] });
  const out = await validate(engine, llm({ approvedActions: [pauseKw] }));
  assert.equal(out.approvedCount, 0);
});

test("Validate: a budget RAISE above the daily cap is dropped unless throttling", async () => {
  const raise = { type: "set_daily_budget", valueILS: 20 };
  const notThrottling = await validate(baseEngine({ budgetStatus: "ok", candidateActions: [raise] }), llm({ approvedActions: [raise] }));
  assert.equal(notThrottling.approvedCount, 0);
  const lowering = { type: "set_daily_budget", valueILS: 13 };
  const ok = await validate(baseEngine({ budgetStatus: "ok", candidateActions: [lowering] }), llm({ approvedActions: [lowering] }));
  assert.equal(ok.approvedCount, 1);
});

test("Validate: UNPARSEABLE LLM output falls back to the engine plan verbatim", async () => {
  for (const bad of [{ message: { content: "not json at all" } }, { message: { content: "{broken" } }, {}, { message: { content: JSON.stringify({ approvedActions: "nope" }) } }]) {
    const out = await validate(baseEngine(), bad);
    assert.equal(out.approvedCount, 3, JSON.stringify(bad));
    assert.match(out.summary, /LLM unavailable/);
  }
});

test("Validate: DRY_RUN is false in the committed workflow (live mode) and the Google Ads URL/ids are the baked-in ones", async () => {
  const out = await validate(baseEngine(), llm({ approvedActions: [budgetAct] }));
  assert.equal(out.DRY_RUN, false);
  assert.match(out.mutations[0].url, /^https:\/\/googleads\.googleapis\.com\/v25\/customers\/\d+\/campaignBudgets:mutate$/);
  assert.equal(out.mutations[0].body.operations[0].update.amountMicros, "9000000");
  assert.equal(out.mutations[0].body.operations[0].updateMask, "amountMicros");
});

test("Validate: mutation payload shapes for every action type", async () => {
  const resume = { type: "resume_campaign", reason: "r" };
  const engine = baseEngine({ budgetStatus: "ok", candidateActions: [pauseCamp, resume, pauseKw, neg] });
  const out = await validate(engine, llm({ approvedActions: [pauseCamp, resume, pauseKw, neg] }));
  const byLabel = Object.fromEntries(out.mutations.map((m) => [m.label, m]));
  assert.equal(byLabel["PAUSE CAMPAIGN (monthly cap)"].body.operations[0].update.status, "PAUSED");
  assert.equal(byLabel["RESUME CAMPAIGN (budget available)"].body.operations[0].update.status, "ENABLED");
  assert.equal(byLabel["pause: kw"].body.operations[0].update.resourceName, pauseKw.criterionId);
  assert.deepEqual(byLabel["negative: bad term"].body.operations[0].create, { campaign: norm.campaign.resourceName, negative: true, keyword: { text: "bad term", matchType: "PHRASE" } });
});

test("KNOWN WEAKNESS (J-14): the LLM can veto the budget cap - approving [] drops pause_campaign / throttle, nothing enforces them", async () => {
  const engine = baseEngine({ budgetStatus: "cap_reached", candidateActions: [pauseCamp] });
  const out = await validate(engine, llm({ approvedActions: [], summary: "nothing to do" }));
  assert.equal(out.approvedCount, 0);
  assert.deepEqual(out.mutations, []);
  assert.equal(out.budgetStatus, "cap_reached", "the report still says cap_reached");
});

test("KNOWN WEAKNESS (J-17): a missing budgetResourceName / resourceName yields a mutation with a null resourceName", async () => {
  const [{ json }] = await run("Validate & Gate", { input: llm({ approvedActions: [budgetAct] }), upstream: { "Rules Engine": baseEngine(), Normalize: { campaign: { resourceName: null, budgetResourceName: null } } } });
  assert.equal(json.mutations[0].body.operations[0].update.resourceName, null);
});

test("Validate: websitePR is passed only when it has a title", async () => {
  assert.equal((await validate(baseEngine(), llm({ approvedActions: [], websitePR: { rationale: "x" } }))).websitePR, null);
  assert.equal((await validate(baseEngine(), llm({ approvedActions: [], websitePR: { title: "T", rationale: "x" } }))).websitePR.title, "T");
});

// ── Gate nodes ───────────────────────────────────────────────────────────────
test("Gate: mutations emits one item per mutation when live, nothing in DRY_RUN or when empty", async () => {
  const m = [{ url: "u1", body: {}, label: "a" }, { url: "u2", body: {}, label: "b" }];
  assert.equal((await run("Gate: mutations", { input: { DRY_RUN: false, mutations: m } })).length, 2);
  assert.equal((await run("Gate: mutations", { input: { DRY_RUN: true, mutations: m } })).length, 0);
  assert.equal((await run("Gate: mutations", { input: { DRY_RUN: false, mutations: [] } })).length, 0);
});

test("Gate: website proposal emits a GitHub-issue item (title prefixed, capped at 120 chars) only when a proposal exists", async () => {
  assert.equal((await run("Gate: website proposal", { input: { websitePR: null } })).length, 0);
  const out = await run("Gate: website proposal", { input: { websitePR: { title: "x".repeat(300), rationale: "R", files_hint: "F", change_description: "C" }, cpaILS: 70, monthToDateSpendILS: 120 } });
  assert.equal(out.length, 1);
  assert.ok(out[0].json.title.startsWith("[ads-agent] "));
  assert.equal(out[0].json.title.length, 120);
  assert.match(out[0].json.body, /Rationale:\*\* R/);
});

// ── Normalize ────────────────────────────────────────────────────────────────
const rows = (r) => ({ results: r });
function normalize(over = {}) {
  return run("Normalize", {
    upstream: {
      "Read: Campaign+MTD": rows([{ metrics: { costMicros: "123450000", conversions: 2.5, clicks: 40 } }]),
      "Read: Campaign Status": rows([{ campaign: { name: "RSVP Search Campaign", status: "PAUSED", resourceName: "customers/1/campaigns/7" }, campaignBudget: { resourceName: "customers/1/campaignBudgets/8", amountMicros: "13000000" } }]),
      "Read: Keywords 30d": rows([{ adGroupCriterion: { resourceName: "c/1", status: "ENABLED", keyword: { text: "kw1", matchType: "PHRASE" } }, metrics: { costMicros: "70000000", conversions: 0, clicks: 12 } }]),
      "Read: Keywords 90d": rows([{ adGroupCriterion: { resourceName: "c/1" }, metrics: { conversions: 3 } }]),
      "Read: Search terms": rows([{ searchTermView: { searchTerm: "t1" }, metrics: { clicks: 5, costMicros: "20000000", conversions: 0 } }]),
      ...over,
    },
  }).then((o) => o[0].json);
}

test("Normalize: converts micros to ILS, maps status/budget, joins lifetime conversions, sets alreadyNegative=false", async () => {
  const j = await normalize();
  assert.deepEqual(j.campaign, { name: "RSVP Search Campaign", status: "PAUSED", resourceName: "customers/1/campaigns/7", budgetResourceName: "customers/1/campaignBudgets/8", dailyBudgetILS: 13, costILS: 123.45, conversions: 2.5 });
  assert.equal(j.monthToDateSpendILS, 123.45);
  assert.deepEqual(j.keywords[0], { criterionId: "c/1", text: "kw1", matchType: "PHRASE", status: "ENABLED", costILS: 70, conversions: 0, clicks: 12, conversionsAllTime: 3 });
  assert.deepEqual(j.searchTerms[0], { term: "t1", clicks: 5, costILS: 20, conversions: 0, alreadyNegative: false });
  const now = new Date();
  assert.equal(j.dayOfMonth, now.getUTCDate());
  assert.equal(j.daysInMonth, new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate());
});

test("KNOWN WEAKNESS (J-17): empty Google Ads results silently become cost 0, status UNKNOWN, budget 0, null resource names", async () => {
  const empty = rows([]);
  const j = await normalize({ "Read: Campaign+MTD": empty, "Read: Campaign Status": empty, "Read: Keywords 30d": empty, "Read: Keywords 90d": empty, "Read: Search terms": empty });
  assert.equal(j.campaign.status, "UNKNOWN");
  assert.equal(j.monthToDateSpendILS, 0);
  assert.equal(j.campaign.dailyBudgetILS, 0);
  assert.equal(j.campaign.resourceName, null);
  assert.equal(j.campaign.budgetResourceName, null);
});

test("KNOWN WEAKNESS (J-25): search terms are not aggregated - one row per ad group stays as separate rows", async () => {
  const j = await normalize({ "Read: Search terms": rows([
    { searchTermView: { searchTerm: "dup" }, metrics: { clicks: 2, costMicros: "8000000" } },
    { searchTermView: { searchTerm: "dup" }, metrics: { clicks: 2, costMicros: "8000000" } },
  ]) });
  assert.equal(j.searchTerms.length, 2);
});

// ── Normalize: who paused the campaign (change history) ──────────────────────
const CAMP = "customers/1/campaigns/7";
const chg = (over = {}) => ({ changeEvent: { changeDateTime: "2026-11-01 05:00:00.000000", changeResourceName: CAMP, clientType: "GOOGLE_ADS_API", changedFields: "status", newResource: { campaign: { status: "PAUSED" } }, ...over } });
const changes = (...r) => ({ "Read: Campaign Changes": rows(r) });

test("pausedByAgent: the latest status change is an API pause -> true", async () => {
  const j = await normalize(changes(chg()));
  assert.equal(j.pausedByAgent, true);
  assert.deepEqual(j.lastStatusChange, { status: "PAUSED", clientType: "GOOGLE_ADS_API", at: "2026-11-01 05:00:00.000000" });
  assert.equal(j.campaign.resourceName, CAMP, "the campaign object is unchanged");
});

test("pausedByAgent: the latest status change is a web-UI pause -> false", async () => {
  const j = await normalize(changes(chg({ clientType: "GOOGLE_ADS_WEB_CLIENT" })));
  assert.equal(j.pausedByAgent, false);
  assert.equal(j.lastStatusChange.clientType, "GOOGLE_ADS_WEB_CLIENT");
});

test("pausedByAgent: an older API pause followed by a newer web-UI ENABLED -> false", async () => {
  const j = await normalize(changes(
    chg({ changeDateTime: "2026-10-01 05:00:00.000000" }),
    chg({ changeDateTime: "2026-10-20 09:00:00.000000", clientType: "GOOGLE_ADS_WEB_CLIENT", newResource: { campaign: { status: "ENABLED" } } }),
  ));
  assert.equal(j.pausedByAgent, false);
  assert.equal(j.lastStatusChange.status, "ENABLED");
});

test("pausedByAgent: an event for another campaign is ignored", async () => {
  const j = await normalize(changes(chg({ changeResourceName: "customers/1/campaigns/99" })));
  assert.equal(j.pausedByAgent, false);
  assert.equal(j.lastStatusChange, null);
});

test("pausedByAgent: a change that did not touch status (name only) is ignored", async () => {
  const j = await normalize(changes(chg({ changedFields: "name" })));
  assert.equal(j.pausedByAgent, false);
  assert.equal(j.lastStatusChange, null);
});

test("pausedByAgent: changedFields as a FieldMask object { paths: [...] } is handled", async () => {
  const j = await normalize(changes(chg({ changedFields: { paths: ["name", "status"] } })));
  assert.equal(j.pausedByAgent, true);
  const k = await normalize(changes(chg({ changedFields: "name,status" })));
  assert.equal(k.pausedByAgent, true);
});

test("pausedByAgent: unordered rows are sorted by time, the newest wins", async () => {
  const newestWeb = chg({ changeDateTime: "2026-11-01 09:00:00.000000", clientType: "GOOGLE_ADS_WEB_CLIENT" });
  const olderApi = chg({ changeDateTime: "2026-10-05 05:00:00.000000" });
  assert.equal((await normalize(changes(olderApi, newestWeb))).pausedByAgent, false);
  assert.equal((await normalize(changes(newestWeb, olderApi))).pausedByAgent, false);
  const newestApi = chg({ changeDateTime: "2026-11-02 05:00:00.000000" });
  const olderWeb = chg({ changeDateTime: "2026-10-05 05:00:00.000000", clientType: "GOOGLE_ADS_WEB_CLIENT" });
  assert.equal((await normalize(changes(newestApi, olderWeb))).pausedByAgent, true);
  assert.equal((await normalize(changes(olderWeb, newestApi))).pausedByAgent, true);
});

test("pausedByAgent: the change node missing from the run gives false and a null lastStatusChange", async () => {
  const j = await normalize(); // default leaves "Read: Campaign Changes" out
  assert.equal(j.pausedByAgent, false);
  assert.equal(j.lastStatusChange, null);
});

test("pausedByAgent: an error item from the change node gives false", async () => {
  const j = await normalize({ "Read: Campaign Changes": { error: { message: "fake failure", status: 403 } } });
  assert.equal(j.pausedByAgent, false);
  assert.equal(j.lastStatusChange, null);
});

test("pausedByAgent: no resourceName on the campaign (status read failed) gives false", async () => {
  const empty = rows([]);
  const j = await normalize({ "Read: Campaign Status": empty, ...changes(chg()) });
  assert.equal(j.pausedByAgent, false);
});

// ── Read: Campaign Changes node (structure) ──────────────────────────────────
test("Read: Campaign Changes node: a copy of Read: Campaign Status that queries change_event and continues on error", () => {
  const status = wf.nodes.find((n) => n.name === "Read: Campaign Status");
  const node = wf.nodes.find((n) => n.name === "Read: Campaign Changes");
  assert.ok(node, "node exists");
  assert.equal(node.type, "n8n-nodes-base.httpRequest");
  assert.equal(node.parameters.method, "POST");
  assert.equal(node.parameters.url, status.parameters.url);
  assert.equal(node.parameters.nodeCredentialType, status.parameters.nodeCredentialType);
  assert.deepEqual(node.parameters.headerParameters.parameters.map((p) => p.name), status.parameters.headerParameters.parameters.map((p) => p.name));
  const q = node.parameters.jsonBody;
  assert.match(q, /FROM change_event/);
  assert.match(q, /change_resource_type = 'CAMPAIGN'/);
  assert.match(q, /LIMIT 100/);
  assert.ok(q.includes("$now.minus({ days: 28 })"));
  assert.equal(node.onError, "continueRegularOutput");
  assert.equal(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length, "node ids are unique");
});

test("workflow connections run Read: Campaign Status -> Read: Campaign Changes -> Read: Keywords 30d, nothing reaches Apply from the new node", () => {
  const to = (name) => (wf.connections[name].main[0] || []).map((c) => c.node);
  assert.deepEqual(to("Read: Campaign Status"), ["Read: Campaign Changes"]);
  assert.deepEqual(to("Read: Campaign Changes"), ["Read: Keywords 30d"]);
  assert.ok(!JSON.stringify(wf.connections["Read: Campaign Changes"]).includes("Apply to Google Ads"));
});

// ── Build LLM request ────────────────────────────────────────────────────────
test("Build LLM request: Ollama chat body with the engine output as the user message, strict-JSON format, low temperature", async () => {
  const data = { budgetStatus: "ok", candidateActions: [], winners: [] };
  const [{ json }] = await run("Build LLM request", { input: data });
  assert.equal(json.stream, false);
  assert.equal(json.format, "json");
  assert.equal(json.options.temperature, 0.2);
  assert.equal(json.messages[0].role, "system");
  assert.deepEqual(JSON.parse(json.messages[1].content), data);
  assert.match(json.messages[0].content, /subset of candidateActions/);
});
