# Autonomous Google Ads Campaign Manager (n8n)

A self-hosted n8n workflow that optimizes the **RSVP Search Campaign** daily, within hard limits.
"Rules + AI reviewer": deterministic guardrails decide what's *allowed*; a local LLM reviews and
prioritizes; every ad change is applied automatically, every **website** change is proposed as a
**GitHub PR** for you to approve.

## Hard limits (enforced in code, not left to the AI)
1. **No spend on the site** — the agent only touches the free-tier infra + the ad account. It never
   buys or upgrades anything. The AI runs on a **local** model (Ollama), so even the "brain" is free.
2. **≤ ₪400/month on Google Ads** — enforced two ways:
   - Daily budget is pinned to **₪13/day** (₪13 × 30.4 ≈ ₪395 ≤ ₪400 — Google caps monthly at daily×30.4).
   - The workflow also reads **month-to-date spend** each run and throttles the daily budget down (or
     pauses the campaign) if the projected month would exceed ₪400.
3. **Never pauses a keyword that has ever converted** (winners are protected).
4. **Website = propose only** — the agent opens a PR against `muaddibbb/rsvp-platform`; your merge is the gate. It never deploys.
5. **Max 8 changes per run** — no wild swings.
6. **Auto-resumes** a paused campaign once a new month's budget is available (spend resets near ₪0), so
   the cap-pause isn't permanent — you don't have to manually re-enable it every month.

## Status: live and proven working (Sep 2026)
Deployed to the real account (`RSVP Search Campaign`, customer 3674361839, manager 4057140705). Has
correctly applied real mutations end-to-end: paused a keyword, added negatives, paused the campaign at
the ₪400 cap, and — after the fixes below — **auto-resumed it for real** once the new month's budget
became available. AI reviewer (Ollama, `qwen2.5:3b-instruct`) is live and reasoning correctly (e.g. it
independently caught and rejected a proposed negative keyword that would have blocked one of the two
converting/winning keywords — the review layer is adding real value, not just rubber-stamping). Daily
schedule is active.

## Files
- `campaign-manager.workflow.json` — importable n8n workflow (finalize after the API token is live).
- `rules-engine.js` — deterministic guardrail + candidate-action logic (source for the Code node).
- `ai-reviewer-prompt.md` — system prompt for the local LLM reviewer.
- `gaql-and-api.md` — the Google Ads read queries (GAQL) and write (mutate) API reference.

## Architecture
```
Daily schedule (n8n) →
  READ    Google Ads API: campaign+budget, keyword stats (30d), search terms (30d), month-to-date spend
  DECIDE  rules-engine.js (Code node) → candidate actions + budget status + winners  [deterministic]
  REVIEW  Ollama (local LLM) with ai-reviewer-prompt.md → approves/reorders, drafts any website PR
  VALIDATE Code node re-checks the LLM output against the hard limits (final gate)
  ACT     Google Ads API mutate: add negatives, pause losers, set/throttle budget, pause if capped
  PROPOSE GitHub API: open a PR if a website change is warranted
  REPORT  email summary: changes made, CPA, spend vs ₪400 cap, pending PRs
```
The LLM can only **approve/reject/reorder** actions the rules engine already sanctioned, and **draft**
website PRs. It can never invent an ad change or raise the budget beyond the cap — the Validate node
drops anything outside the sanctioned set.

## Setup

### 1. Ollama (free local LLM on your home server)
```bash
# Linux/macOS — installs the Ollama runtime
curl -fsSL https://ollama.com/install.sh | sh
# Pull a small, capable instruction/JSON model (~5 GB, runs on ~8 GB RAM)
ollama pull llama3.1:8b
# Verify it's serving (default port 11434)
curl http://localhost:11434/api/tags
```
If your server is light on RAM, use `qwen2.5:3b-instruct` instead (smaller, still solid at JSON).
n8n reaches Ollama at `http://localhost:11434` (or your server's LAN IP if n8n runs in Docker).

### 2. Google Ads API credentials (the slow part — you're getting these)
You'll need, stored in **n8n credentials** (never in this repo or chat):
- **Developer token** (Google Ads → Tools → API Center; apply for Basic access)
- **OAuth2 client ID + secret** (Google Cloud Console → enable "Google Ads API" → OAuth client, Desktop)
- **Refresh token** (OAuth flow, signed in as the ads-account manager)
- **Customer ID** (`xxx-xxx-xxxx`, digits only in API calls)

n8n has a native **Google Ads OAuth2** credential type — fill client id/secret there, then it walks
you through consent to mint the refresh token. The developer token goes in the HTTP node header
`developer-token`.

### 3. GitHub token (for website PRs)
A fine-grained **Personal Access Token** with `contents:write` + `pull_requests:write` on
`muaddibbb/rsvp-platform`. Stored in n8n credentials.

### 4. Import & wire the workflow
Import `campaign-manager.workflow.json` in n8n → open each credential-bound node → pick your
credentials → set `CUSTOMER_ID` in the Code node config. Run once manually in **dry-run mode**
(the Validate node has a `DRY_RUN` flag) and read the report before enabling the schedule.

## Rollout plan (safe)
1. **Read-only** first: run the READ + DECIDE + REVIEW + REPORT path with `DRY_RUN=true`. Confirm the
   proposed actions look sane in the email for a few days.
2. **Enable ad writes** (`DRY_RUN=false`) — negatives, pausing losers, budget throttle. Watch a week.
3. **Enable website PRs** — start reviewing/merging its suggestions.

## Hard-won lessons from the first real deployment
These cost real debugging time — check them first if something similar happens again.
1. **`developer-token` is a required header on every single Google Ads HTTP node**, separate from OAuth.
   Missing it (or a typo in the header name) produces a generic "Bad request — please check your
   parameters", not an auth-specific error.
2. **The API version drifts.** Google retires versions yearly; a stale version 404s. It's hardcoded in
   two places that are easy to miss during an update: the 4 Read nodes' URLs, AND a separate `API` const
   inside the "Validate & Gate" code node (not a visible URL field).
3. **OAuth consent screen must be "In production", not "Testing".** Testing-mode refresh tokens silently
   expire after 7 days, surfacing as `invalid_grant` errors days later. Publishing requires an app
   homepage + privacy policy URL filled in on the Branding page first.
4. **`CONCURRENT_MODIFICATION` errors** — firing several mutate calls at the same campaign back-to-back
   gets randomly rejected by Google's backend ("Multiple requests were attempting to modify the same
   resource at once. Retry the request."). This looks identical to a real bug (generic 400, empty error
   detail) and caused hours of chasing a phantom code issue. Fixed via **Batching** (Items per Batch=1,
   Batch Interval=2000ms) + **Retry On Fail** on the "Apply to Google Ads" node.
5. **n8n hides Google's detailed error body by default.** The real error (with the specific invalid
   field, via `details[].errors[].location.fieldPathElements`) only shows up if you temporarily enable
   **"Never Error"** + **"Include Response Headers and Status"** under the HTTP node's Options — revert
   both after debugging, since "Never Error" would otherwise hide real future failures as fake successes.
6. **A metrics-filtered query can silently return zero rows near the start of a month.** The original
   "Read: Campaign+MTD" query filters `segments.date DURING THIS_MONTH` — when the campaign had no
   activity yet this month (e.g. right after being paused), this returned no row at all, so
   `campaign.status` silently defaulted to `'UNKNOWN'` instead of the real `'PAUSED'`. That broke the
   resume logic (condition never matched) and would have broken every other mutation too (no
   `resourceName` to target). **Fix:** a separate "Read: Campaign Status" query with no date filter at
   all — it always returns exactly one row with the campaign's real current status/resourceName/budget.
   "Read: Campaign+MTD" is now used only for the this-month cost/conversions metrics, which safely
   default to 0 on empty results (that part was always fine — only the campaign-attributes reuse was the bug).
7. **An 8B-parameter local model can be genuinely slow to cold-start on modest CPU-only hardware**
   (4 cores, ~8GB RAM here). The first Ollama call after a restart can exceed a 120s timeout purely from
   loading the model into memory. **Fix:** switched to `qwen2.5:3b-instruct` (much lighter, still solid
   for structured JSON review) and raised the HTTP timeout to 300000ms as a safety margin.
   Separately: **Ollama binds to `127.0.0.1` by default** — unreachable from n8n's Docker container. Fix:
   `sudo systemctl edit ollama` → add `Environment="OLLAMA_HOST=0.0.0.0:11434"` → daemon-reload + restart.
8. **n8n code-node edits sometimes silently fail to persist**, especially after a lot of back-and-forth
   editing in one session. Twice during initial setup, a verified-correct code change (the resume-logic
   block in "Rules Engine", then the `resume_campaign` mutation case in "Validate & Gate") turned out to
   be missing from the live node on the next run, with no error or warning. **After editing critical
   logic, close and reopen the node to confirm the change actually saved before trusting it.**

## Tuning knobs (`rules-engine.js` CONFIG)
Budget cap, daily budget, lookback window, pause/negative thresholds, and max-actions-per-run are all
constants at the top of `rules-engine.js`. Change them there; the AI reviewer reads the same limits.
