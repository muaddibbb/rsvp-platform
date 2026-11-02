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

### C. Keyword all-time conversions (winner protection) — no date filter
```sql
SELECT ad_group_criterion.criterion_id, metrics.conversions
FROM keyword_view
WHERE campaign.name = 'RSVP Search Campaign'
```
GAQL has no `LAST_90_DAYS` literal — an earlier version of this query used `LAST_30_DAYS` here (identical
to query B's window), which meant "winner protection" wasn't actually a wider window at all: a keyword
that converted once, 40+ days ago, showed 0 conversions in both queries and got auto-paused as a loser.
**Omitting `segments.date` entirely** aggregates `metrics.conversions` over the keyword's full lifetime —
this is the correct "has this ever converted" check. Map into each keyword as `conversionsAllTime`
(any > 0 ⇒ protected winner, permanently, regardless of how long ago).

### D. Search terms (for negatives)
```sql
SELECT search_term_view.search_term, metrics.clicks, metrics.cost_micros, metrics.conversions
FROM search_term_view
WHERE segments.date DURING LAST_30_DAYS
  AND campaign.name = 'RSVP Search Campaign'
```

### E. Campaign status change history (who paused it)
```sql
SELECT change_event.change_date_time, change_event.change_resource_name, change_event.client_type,
       change_event.changed_fields, change_event.new_resource, change_event.resource_change_operation
FROM change_event
WHERE change_event.change_resource_type = 'CAMPAIGN'
  AND change_event.change_date_time >= '2026-10-05'
  AND change_event.change_date_time <= '2026-11-03'
ORDER BY change_event.change_date_time DESC
LIMIT 100
```
(In the workflow the two dates are computed: today minus 28 days, and today plus 1 day.)
Mapping, per returned row (`changeEvent`): keep it only when `changeResourceName` equals the campaign's
resource name, `changedFields` contains `status` (a comma-separated string, or an object with `paths`), and
`newResource.campaign.status` is present. Take the newest such row by `changeDateTime`. The agent resumes
the campaign only if that row's `newResource.campaign.status` is `PAUSED` and its `clientType` is
`GOOGLE_ADS_API` (a pause made through the API, i.e. by this agent). `GOOGLE_ADS_WEB_CLIENT`,
`GOOGLE_ADS_MOBILE_APP`, scripts, automated rules, no row at all, or a failed read all mean "not the agent":
no resume.
Limits: the date range must be within the last 30 days; `LIMIT` is required and at most 10,000; changes made
in Google Ads Editor are not visible; a change can take up to 3 minutes to appear.

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

### Resume the campaign — POST `.../campaigns:mutate`
```json
{ "operations": [ {
  "updateMask": "status",
  "update": { "resourceName": "customers/{CID}/campaigns/{CAMPAIGN_ID}", "status": "ENABLED" }
} ] }
```

## Validate node (final gate, before any write)
- Drop any ad action not present in `candidateActions`.
- Reject any `set_daily_budget` with `amountMicros > 13000000` unless `budgetStatus === "throttling"`.
- Reject any `pause_keyword` whose keyword is in `winners`.
- Resume only when the engine emitted `resume_campaign` (which requires `pausedByAgent`).
- Honor `DRY_RUN`: when true, log the plan + skip all mutate calls.
