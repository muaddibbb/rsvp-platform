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

## Tuning knobs (`rules-engine.js` CONFIG)
Budget cap, daily budget, lookback window, pause/negative thresholds, and max-actions-per-run are all
constants at the top of `rules-engine.js`. Change them there; the AI reviewer reads the same limits.
