/**
 * Deterministic guardrail + candidate-action engine for the RSVP Google Ads agent.
 *
 * Runs in an n8n Code node ("Run Once for All Items"). It takes normalized performance
 * data and produces a SAFE, bounded set of *candidate* actions. The AI reviewer may only
 * approve / reject / reorder these — it can never exceed what this file sanctions. The
 * Validate node re-checks the final plan against these same limits before anything is applied.
 *
 * Money limits live here and nowhere else:
 *   - Google Ads spend is capped at ₪400/month (daily budget pinned + month-to-date throttle).
 *   - The agent never spends on the site itself (it only ever emits ad mutations + GitHub PRs).
 */

const CONFIG = {
  CAMPAIGN_NAME: "RSVP Search Campaign",
  MONTHLY_BUDGET_CAP_ILS: 400,
  DAILY_BUDGET_ILS: 13, // 13 × 30.4 ≈ 395 ≤ 400
  PRICE_ILS: 99, // product price → target-CPA anchor; CPA < price = profitable
  LOOKBACK_DAYS: 30,

  // Pause a keyword only if it spent real money, has 0 conversions in the window,
  // AND has never converted (winners are protected).
  KEYWORD_PAUSE_MIN_SPEND_ILS: 60,

  // Add a search term as a negative if it drew clicks/spend and never converted.
  NEGATIVE_MIN_CLICKS: 4,
  NEGATIVE_MIN_SPEND_ILS: 15,

  MAX_ACTIONS_PER_RUN: 8, // no wild swings
};

/**
 * @param {object} input
 * @param {{name,status,dailyBudgetILS,costILS,conversions}} input.campaign
 * @param {Array<{criterionId,text,matchType,status,costILS,conversions,clicks,conversionsAllTime}>} input.keywords
 * @param {Array<{term,clicks,costILS,conversions,alreadyNegative}>} input.searchTerms
 * @param {number} input.monthToDateSpendILS
 * @param {number} input.dayOfMonth   (1-31)
 * @param {number} input.daysInMonth  (28-31)
 */
function decide(input) {
  const { campaign, keywords = [], searchTerms = [], monthToDateSpendILS = 0, dayOfMonth = 1, daysInMonth = 30 } = input;
  const actions = [];
  const notes = [];

  // ── 1. Budget guardrails (the ₪400/month cap) ─────────────────────────────
  const remainingDays = Math.max(1, daysInMonth - dayOfMonth + 1);
  const projectedMonth = monthToDateSpendILS + CONFIG.DAILY_BUDGET_ILS * remainingDays;
  let budgetStatus = "ok";

  if (monthToDateSpendILS >= CONFIG.MONTHLY_BUDGET_CAP_ILS) {
    actions.push({
      type: "pause_campaign",
      reason: `Month-to-date spend ₪${monthToDateSpendILS} reached the ₪${CONFIG.MONTHLY_BUDGET_CAP_ILS} cap`,
    });
    budgetStatus = "cap_reached";
  } else if (projectedMonth > CONFIG.MONTHLY_BUDGET_CAP_ILS) {
    const safeDaily = Math.max(1, Math.floor((CONFIG.MONTHLY_BUDGET_CAP_ILS - monthToDateSpendILS) / remainingDays));
    if (Math.round(campaign.dailyBudgetILS) !== safeDaily) {
      actions.push({
        type: "set_daily_budget",
        valueILS: safeDaily,
        reason: `Throttle to keep month ≤ ₪${CONFIG.MONTHLY_BUDGET_CAP_ILS} (projected ₪${Math.round(projectedMonth)})`,
      });
    }
    budgetStatus = "throttling";
  } else if (Math.round(campaign.dailyBudgetILS) > CONFIG.DAILY_BUDGET_ILS) {
    actions.push({
      type: "set_daily_budget",
      valueILS: CONFIG.DAILY_BUDGET_ILS,
      reason: `Enforce the ≤ ₪${CONFIG.DAILY_BUDGET_ILS}/day cap (was ₪${Math.round(campaign.dailyBudgetILS)})`,
    });
  }

  // ── 2. Pause proven money-losing keywords (never touch winners) ───────────
  const losers = keywords
    .filter(
      (k) =>
        k.status === "ENABLED" &&
        (k.conversions || 0) === 0 &&
        (k.conversionsAllTime || 0) === 0 && // never converted → safe to pause
        (k.costILS || 0) >= CONFIG.KEYWORD_PAUSE_MIN_SPEND_ILS
    )
    .sort((a, b) => b.costILS - a.costILS);
  for (const k of losers) {
    actions.push({
      type: "pause_keyword",
      criterionId: k.criterionId,
      keyword: k.text,
      matchType: k.matchType,
      reason: `₪${k.costILS} spent, 0 conversions over ${CONFIG.LOOKBACK_DAYS}d`,
    });
  }

  // ── 3. Add negatives for wasteful search terms ────────────────────────────
  const waste = searchTerms
    .filter(
      (t) =>
        (t.conversions || 0) === 0 &&
        (t.clicks || 0) >= CONFIG.NEGATIVE_MIN_CLICKS &&
        (t.costILS || 0) >= CONFIG.NEGATIVE_MIN_SPEND_ILS &&
        !t.alreadyNegative
    )
    .sort((a, b) => b.costILS - a.costILS);
  for (const t of waste) {
    actions.push({
      type: "add_negative",
      text: t.term,
      matchType: "PHRASE",
      reason: `₪${t.costILS}, ${t.clicks} clicks, 0 conversions`,
    });
  }

  // ── Context for the AI reviewer + report ──────────────────────────────────
  const winners = keywords
    .filter((k) => (k.conversionsAllTime || 0) > 0)
    .map((k) => ({
      keyword: k.text,
      matchType: k.matchType,
      cpaILS: k.conversions ? Math.round(k.costILS / k.conversions) : null,
    }));

  const totalCost = campaign.costILS || 0;
  const totalConv = campaign.conversions || 0;
  const cpaILS = totalConv ? Math.round(totalCost / totalConv) : null;

  if (budgetStatus === "cap_reached") notes.push("Budget cap reached — campaign will be paused until next month.");
  if (cpaILS != null && cpaILS < CONFIG.PRICE_ILS) notes.push(`CPA ₪${cpaILS} is BELOW the ₪${CONFIG.PRICE_ILS} price — profitable.`);

  const candidateActions = actions.slice(0, CONFIG.MAX_ACTIONS_PER_RUN);
  return {
    budgetStatus,
    monthToDateSpendILS,
    projectedMonthILS: Math.round(projectedMonth),
    cpaILS,
    profitable: cpaILS != null && cpaILS < CONFIG.PRICE_ILS,
    winners,
    candidateActions,
    droppedActions: Math.max(0, actions.length - candidateActions.length),
    config: CONFIG,
    notes,
  };
}

// ── n8n Code node entry point ───────────────────────────────────────────────
// Upstream nodes must assemble the normalized `input` shape onto $json.
// eslint-disable-next-line no-undef
if (typeof $input !== "undefined") {
  // eslint-disable-next-line no-undef
  return [{ json: decide($input.first().json) }];
}

module.exports = { decide, CONFIG }; // for local unit testing
