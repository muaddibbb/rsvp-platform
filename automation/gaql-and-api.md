# Google Ads API — reads (GAQL) and writes (mutate)

API version paths below use `v18` — bump to whatever is current when you set up. All requests go to
`https://googleads.googleapis.com/{version}/customers/{CUSTOMER_ID}/...`.

## Common headers (every request)
```
Authorization: Bearer {oauth_access_token}   # n8n Google Ads OAuth2 credential mints this
developer-token: {DEVELOPER_TOKEN}
login-customer-id: {MANAGER_ID or CUSTOMER_ID, digits only}
Content-Type: application/json
```

## READS — POST `.../googleAds:search`  (body: `{ "query": "<GAQL>" }`)

### A. Campaign + daily budget + month-to-date spend
```sql
SELECT campaign.id, campaign.name, campaign.status,
       campaign_budget.amount_micros,
       metrics.cost_micros, metrics.conversions, metrics.clicks
FROM campaign
WHERE campaign.name = 'RSVP Search Campaign'
  AND segments.date DURING THIS_MONTH
```
`campaign_budget.amount_micros / 1e6` = daily budget in ₪. Sum `metrics.cost_micros / 1e6` = month-to-date ₪.

### B. Keyword performance (decision window)
```sql
SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
       ad_group_criterion.keyword.match_type, ad_group_criterion.status,
       metrics.cost_micros, metrics.conversions, metrics.clicks
FROM keyword_view
WHERE segments.date DURING LAST_30_DAYS
  AND campaign.name = 'RSVP Search Campaign'
```

### C. Keyword all-time-ish conversions (winner protection) — wider window
```sql
SELECT ad_group_criterion.criterion_id, metrics.conversions
FROM keyword_view
WHERE segments.date DURING LAST_90_DAYS
  AND campaign.name = 'RSVP Search Campaign'
```
Map into each keyword as `conversionsAllTime` (any > 0 ⇒ protected winner).

### D. Search terms (for negatives)
```sql
SELECT search_term_view.search_term, metrics.clicks, metrics.cost_micros, metrics.conversions
FROM search_term_view
WHERE segments.date DURING LAST_30_DAYS
  AND campaign.name = 'RSVP Search Campaign'
```

> Normalize all `cost_micros` to ₪ by dividing by 1,000,000. Build the `input` object exactly as
> `rules-engine.js` expects (campaign, keywords[], searchTerms[], monthToDateSpendILS, dayOfMonth, daysInMonth).

## WRITES — mutate endpoints (only after DRY_RUN validation)

### Pause a keyword — POST `.../adGroupCriteria:mutate`
```json
{ "operations": [ {
  "updateMask": "status",
  "update": { "resourceName": "customers/{CID}/adGroupCriteria/{AD_GROUP_ID}~{CRITERION_ID}", "status": "PAUSED" }
} ] }
```

### Add a campaign negative keyword — POST `.../campaignCriteria:mutate`
```json
{ "operations": [ {
  "create": { "campaign": "customers/{CID}/campaigns/{CAMPAIGN_ID}",
    "negative": true,
    "keyword": { "text": "חינם", "matchType": "PHRASE" } }
} ] }
```

### Set / throttle the daily budget — POST `.../campaignBudgets:mutate`
```json
{ "operations": [ {
  "updateMask": "amount_micros",
  "update": { "resourceName": "customers/{CID}/campaignBudgets/{BUDGET_ID}", "amountMicros": "13000000" }
} ] }
```
(₪13 → `13000000` micros. Never exceed `13000000` except a *lower* throttle value.)

### Pause the campaign (cap reached) — POST `.../campaigns:mutate`
```json
{ "operations": [ {
  "updateMask": "status",
  "update": { "resourceName": "customers/{CID}/campaigns/{CAMPAIGN_ID}", "status": "PAUSED" }
} ] }
```

## Validate node (final gate, before any write)
- Drop any ad action not present in `candidateActions`.
- Reject any `set_daily_budget` with `amountMicros > 13000000` unless `budgetStatus === "throttling"`.
- Reject any `pause_keyword` whose keyword is in `winners`.
- Honor `DRY_RUN`: when true, log the plan + skip all mutate calls.
