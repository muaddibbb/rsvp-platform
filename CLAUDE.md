# Kupernet RSVP Platform — Reference

Hebrew-first (RTL) RSVP SaaS at **rsvp.kupernet.com**. One-time **₪99** per event.
This file is the source of truth for how the system works — consult it before digging through code.
Keep it updated when behavior changes.

## Stack & hosting
- **Frontend:** static HTML/CSS/JS in `public/` (no framework/build).
- **Backend:** Vercel serverless functions in `api/` (Node.js, CommonJS `module.exports`).
- **DB:** Supabase (Postgres). **Email:** Brevo API. **Payments:** PayPal REST v2 (LIVE). **PDF:** PDFKit.
- **Deploy:** Vercel Git integration (PROPOSED, see `### Deploy`): the customer connected the Vercel project to github.com/muaddibbb/rsvp-platform on 2 Nov 2026 and set an Ignored Build Step so that only `main` builds; merging to `main` deploys production automatically. Do not run npx vercel --prod or vercel deploy. Personal Vercel team `kupernet`, project `rsvp-platform`. Domain `rsvp.kupernet.com`. For Deployment Protection see the Vercel settings. Release procedure: see `### Deploy` below.
- **Function limit:** Vercel Hobby = 12. Currently **9** functions. Files in `api/` starting with `_` are shared helpers, NOT functions.
- **Repo:** github.com/muaddibbb/rsvp-platform (`main`).

### Deploy
Read by Edric (release manager: merge, production deploy, smoke check, rollback) and Irulan (repo manager: staging). Production commands run in the main checkout `/Users/rkuperman/rsvp-platform`, never in a run worktree.
- Deploy config status: CONFIRMED 2026-11-03 by the owner (customer reply in chat: "I confirm the Deploy section in CLAUDE.md as written"). The values below were reviewed and tested by the team (runs 20261102-1235-release-one and 20261102-1450-rollback-fix); the per-line PROPOSED notes remain as history. Deploy config changes after this date need the owner's new confirmation.
- Merge method: `merge` (PROPOSED: a merge commit keeps the approved commit SHA in main's history)
- Production URL: https://rsvp.kupernet.com
- Vercel project: `rsvp-platform` under team `kupernet` (Hobby plan, Node 24.x). PROPOSED: seen in `npx vercel project ls` on 2026-11-02; the run log does not show who ran it, so it is not verified.
- Release order (Edric runs only the lines below, in this order): 1. Production previous deployment (BEFORE the merge), 2. merge (`gh pr merge`, per Merge method), 3. Production checkout, 4. Production wait, 5. Production smoke check (only after the wait exited 0), 6. Production rollback only if its rule says so. Production deploy is `none`: there is no deploy step.
- Production previous deployment: `cd /Users/rkuperman/rsvp-platform && npx vercel inspect rsvp.kupernet.com --json` (PROPOSED. Read-only. Run BEFORE the merge, because after the merge Vercel starts deploying main and this line would show the new deployment. Record the JSON `id` and `url` in deploy-report.md. If it fails, or `target` is not `production`, or `readyState` is not `READY`: BLOCKED, do not merge. The customer confirmed on 2 Nov 2026 that `npx vercel inspect rsvp.kupernet.com --json` works: the real output has the fields `id`, `target` "production", `readyState` "READY", `url` and `aliases`.)
- Production deploy: none (PROPOSED. Vercel's Git integration deploys `main` to production automatically when the pull request is merged; the customer reports that the Vercel project `rsvp-platform` was connected to github.com/muaddibbb/rsvp-platform on 2 Nov 2026 and that an Ignored Build Step was set so that only `main` builds (not verified here). Edric must not run any deploy command, including `vercel --prod`, `vercel deploy` or `vercel promote`; he waits with "Production wait". Owner to confirm both, see "Staging deploy".)
- Production checkout: `cd /Users/rkuperman/rsvp-platform && git diff --quiet HEAD && test -z "$(git ls-files --others --exclude-standard)" && git switch main && git pull --ff-only origin main && git diff --quiet HEAD && test -z "$(git ls-files --others --exclude-standard)"` (PROPOSED. Still needed, but no longer to deploy: the smoke check compares the live files with this checkout's `public/`, so it must hold the merged `main`. Run AFTER the merge and BEFORE Production wait. The first two checks run before switching, so uncommitted work is never carried onto `main`. If it fails, do not roll back: the merge is done and Vercel deploys on its own, so report BLOCKED, say the merge happened and that production was not verified.)
- Production wait: `cd /Users/rkuperman/rsvp-platform && bash scripts/wait-for-deploy.sh <previous-deployment-id> 360` (PROPOSED. Read-only. `<previous-deployment-id>` = the `id` recorded by "Production previous deployment"; the only substitution allowed. Run it with the Bash tool timeout set to 600000 ms. One overall deadline: this wait takes at most 360 s and the smoke check at most 180 s plus one 10 s request, so the whole check is 540 s plus one 10 s request, about 550 s; they are two separate Bash calls, each with the Bash tool timeout 600000 ms, which still holds. `WAIT_INSPECT_CMD` is a test knob and is ignored unless WAIT_TEST_MODE=1 is also set; never set either in a release. It polls `npx vercel inspect rsvp.kupernet.com --json` every 10 s until `id` differs from the recorded id AND `readyState` is `READY`. That, not the file hashes, is what "the new version is live" means. Outcomes by exit code: 0 = DEPLOY READY (id changed, READY): run Production smoke check. 2 = DEPLOY TIMEOUT (the id never changed, or inspect could not be read): production did not change, report BLOCKED, do NOT roll back, tell the owner to check the Vercel dashboard. 3 = DEPLOY NOT READY (the id changed but is not READY at the deadline): production not verified, report BLOCKED, do NOT roll back. 64 = usage error: BLOCKED.)
- Production smoke check: `cd /Users/rkuperman/rsvp-platform && bash scripts/smoke-check.sh` (PROPOSED. One pass of about 190 s at most (the 180 s deadline is checked before each curl, and one curl may take 10 s more), GET requests only, run with the Bash tool timeout 600000 ms. Run it only after Production wait exited 0, and once more after a rollback, where VERSION DIFFERENT is expected. Prints HEALTH PASS/FAIL and VERSION MATCH/DIFFERENT (the VERSION lines are an extra signal only: a CDN that lags or a later merge also shows DIFFERENT); exit 0 only when both pass. Exit 2 `SMOKE DEADLINE` = not verified. After a wait that exited 0: exit 0 = DONE; HEALTH FAIL = Production rollback; HEALTH PASS with VERSION DIFFERENT, or exit 2 = BLOCKED, do NOT roll back, report the output.)
- Production rollback: `cd /Users/rkuperman/rsvp-platform && npx vercel rollback <previous-deployment-id> --timeout 5m` (PROPOSED. `<previous-deployment-id>` = the `id` recorded by "Production previous deployment"; this is the only substitution allowed. Never run it without the id: with no argument `vercel rollback` only shows status and rolls nothing back. Roll back ONLY when BOTH hold: Production wait exited 0 (the serving id changed and is READY) AND Production smoke check printed HEALTH FAIL. Never roll back when the wait exited 2 or 3, when the smoke check exited 2, on HEALTH PASS, or when the recorded id equals the serving id: production was not changed, report BLOCKED with the output and leave this config PROPOSED. After a rollback run Production smoke check once and report BLOCKED with the state. Hobby plan: Vercel accepts only the previous production deployment; if another production deployment happened in between (a second merge) and `vercel rollback` refuses the id, report BLOCKED and never choose another id. After a rollback Vercel stops auto-assigning the production domain, so later merges to `main` do NOT go live until the owner runs `npx vercel promote <deployment-url>` or presses "Undo Rollback"; a later release then ends in DEPLOY TIMEOUT for that reason.)
- How Edric's steps map (agents/edric.md, read-only; edric.md was aligned with this section by the customer's decision on 3 Nov 2026 (Leto edited it)):
  - edric.md step 0 (previous deployment): the Production previous deployment line, run BEFORE the merge.
  - edric.md step 1 (merge): the Merge method line.
  - edric.md step 2 (deploy, `none`): there is no GitHub Actions workflow in this repo, so do not use `gh run list` or `gh run watch`; use the declared Production wait. edric.md step 2 does not name the checkout: the declared Production checkout line must be run after the merge and before the smoke check (and before the Production wait), otherwise the smoke VERSION lines say DIFFERENT.
  - edric.md step 3 (verify): the smoke check Edric runs after the merge is the declared Production smoke check, run only after Production wait exited 0.
  - edric.md step 4 (roll back on failure): the rollback conditions of the Production rollback line are stricter than "any failure"; wait exit 2 or 3, smoke exit 2 and HEALTH PASS are BLOCKED, never a rollback.
  - edric.md step 5 (deploy-report.md): record the previous id, the wait exit code and output, the smoke output, and whether a rollback happened.
- Staging deploy: none (PROPOSED: a Vercel Preview deployment uses the Preview environment variables, which are unverified and may be live PayPal and the production database; deployment protection is off. Once the project is connected to GitHub every branch and PR would build a Preview, so the Ignored Build Step in Vercel, so that only `main` builds, must be set before or together with connecting Git (the customer reports on 2 Nov 2026 that it is); if it is ever found unset, Irulan does not push run branches. Keep secrets out of the Preview environment)
- Staging smoke check: none
- Staging URL: none

## Environment variables (names only — never store values here)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BREVO_API_KEY`, `PAYPAL_CLIENT_ID`,
`PAYPAL_SECRET`, `PAYPAL_SANDBOX` (="false" → live), `ADMIN_PASSWORD`, `CRON_SECRET`,
`BASE_URL` (optional, defaults to https://rsvp.kupernet.com), `ORDER_SIGNING_KEY` (optional: key that signs PayPal orders and hashes rate-limit keys; when unset a key is derived from `PAYPAL_SECRET`, so nothing needs to be added), `PAYPAL_MERCHANT_ID` (optional: the merchant id PayPal reports as payee; when set, capture refuses an order whose payee differs; unset = no payee check).

## Data model (Supabase)
- **events**: `id` (uuid), `slug` (unique text), `customer_name/email/phone`, `event_type`,
  `event_name`, `hebrew_date`, `gregorian_date` (date), `event_time`, `location`, `address`,
  `extra_note`, `dashboard_password`, `paid_at` (timestamptz — **NULL = unpaid draft**),
  `active` (bool, default true according to the owner, not yet verified: see `sql/export-schema.sql`; false = deactivated/closed/hidden),
  `final_responses` / `final_guests` (int, snapshot headcounts written **once**, the first time a past paid event is auto-closed; never overwritten (a reactivated closed event is re-closed with its saved headcount kept)),
  `receipt_number` (int, unique when set; the receipt number, assigned once when the event is paid by SQL function `assign_receipt_number` from the gapless counter, never recomputed), `refunded_at` (timestamptz, NULL = not refunded; set from /admin, drives the revenue figure; the PayPal refund itself is manual). Both need `sql/release-two-migration.sql`; the code falls back to the old behaviour until it has been run.
- **rsvps**: `id`, `event_id` (fk), `name`, `attending` (bool), `guests` (int), `notes`, `created_at`.
- **pending_checkouts**: `id` (text = client checkoutId), `customer_*`, `event_*`, `location`,
  `updated_at`, `notified` (bool). Tracks "reached checkout, not yet paid". Rows are purged 7 days
  after `updated_at` (privacy — this is PII for people who never became customers).
- **checkout_abandonments**: `id`, `abandoned_at` (timestamptz), `event_type`. Anonymous, permanent
  (no name/email/phone) — one row per checkout reported in the owner digest (grace passed, buyer has not
  paid since: buyers who paid later are skipped and not logged), so a count survives the 7-day PII purge
  above. If the insert fails, the sweep logs the error and the digest shows a warning; if the table can't
  be read, /admin shows "—". Created via `sql/checkout_abandonments.sql` (run by hand in the Supabase SQL
  editor; idempotent).
- **receipt_counter**: one row (`id=1`, `last_number`): the last receipt number handed out (a counter, so deleting an event never frees its number).
- **rate_limits**: `key` (hash, no raw IP/e-mail), `window_start`, `hits`; used by SQL function `rate_limit_hit` for the public endpoints; rows older than a day are purged by `cleanup.js`.
- Table definitions: `sql/schema.sql` (RECONSTRUCTED FROM CODE, types inferred; to be diffed against the real export) and `sql/release-two-migration.sql` (the owner runs it once in the Supabase SQL editor; idempotent). For the live definitions run `sql/export-schema.sql` (read-only).

**Visibility rule:** guests only ever see events where `paid_at IS NOT NULL AND active <> false`
(PostgREST `neq.false`: a NULL `active` is **not** visible). Unpaid drafts and deactivated events return
404 to guests.

## API functions (`api/`)
1. **create-event.js** — POST. Creates an **unpaid draft** (`paid_at=null`), generates slug +
   `dashboard_password`, emails the organizer their dashboard link. Returns `{slug, dashboard_password}` (the buyer's own new draft). Unauthenticated (drafts are invisible/harmless), but rate limited (20/IP/h, 3/e-mail/h → 429; callers without an `Origin` header get a quarter; a foreign `Origin` → 403; fails open if the counter is missing). All caller text is HTML-escaped in the e-mail.
2. **paypal-config.js** — GET → `{clientId}` for the SDK only (the former `?test=1` credential diagnostic was removed, J-18).
3. **paypal-create-order.js** — POST `{slug, password}` → creates a ₪99 ILS order, returns `{id}`. The order is **signed by the server**: `custom_id = "<slug>.<sig>"` (HMAC, `api/_pay.js`). With a slug the buyer must prove ownership of the unpaid draft (its dashboard password, timing-safe; unknown slug and wrong password both answer 403; a paid event 400). Empty slug = legacy "new event" order (`new.<sig>`). 20 orders/IP/h and 10 attempts/IP+slug/h (429). No signing key → 500.
4. **paypal-capture.js** — POST. Modes:
   - `?pending=1` + `{checkoutId,...}` → upsert a `pending_checkouts` row (reached-checkout beacon). `checkoutId` must match `^[A-Za-z0-9-]{8,64}$`, fields are capped at 200 chars, 30/IP/h and 3/e-mail/day (429).
   - default → capture payment. Order of work: `orderID` must match `^[A-Za-z0-9_-]{8,64}$` (J-05); rate limit 20/IP/h; **GET the order from PayPal and check before any money moves**: `status APPROVED`, one unit, `ILS`, `99`, and the `custom_id` signature (only orders our server created). Every refusal answers **400** (nothing captured; the pay pages re-enable the button). The mode comes from the signed id: a signed slug = **PUBLISH mode** (the draft must exist and be unpaid; a different slug in the body → 400), signed `new` = **legacy create** (insert a fresh paid event; a body slug is ignored). Then capture and verify `captures[0]` COMPLETED/99/ILS: a mismatch → no publish, owner alert, **502** (money may have moved). Publish uses `update ... where paid_at is null`: zero rows (double payment) → owner alert "refund order X" and **409**. On capture failure → owner alert with the (escaped) PayPal reason, 400. A retry of an already **COMPLETED** order we signed → **409** "already paid" (no second capture); any failure after the money moved (publish update / legacy insert error, an exception after the capture, or a capture request that threw or returned non-JSON, "capture status unknown") → owner alert and **502**, while a failure before the capture attempt stays a plain 500 with no alert. Pre-capture checks also refuse an `intent` that is present and not `CAPTURE`, and a `payee.merchant_id` that differs from `PAYPAL_MERCHANT_ID` (payee checked only when that variable is set). The capture request body is unchanged. On success → assigns the receipt number, deletes the pending row, sends confirmation + receipt + owner order-notification (all caller text escaped). Returns `{slug, event_name}` in publish mode (**no `dashboard_password`**), and `{slug, event_name, dashboard_password}` only in legacy mode (the buyer's own new event).
5. **dashboard/[slug].js** — password-gated (`dashboard_password`, timing-safe). Loads event whether
   paid or draft. GET → `{event(+paid flag), stats, rsvps}`. PATCH → edit event fields. DELETE → remove an rsvp.
6. **event/[slug].js** — GET public event data for the guest page (paid+active only).
7. **rsvp/[slug].js** — POST a guest RSVP (paid+active only).
8. **admin-events.js** — Bearer `ADMIN_PASSWORD`. GET = list **paid** events + rsvp counts +
   `abandonedLast30Days` (count from `checkout_abandonments`; `null` when the table can't be read).
   `?receipt=1&slug=` / `?refund=1&slug=` →
   PDF (number = stored `receipt_number`, lazily assigned if missing; date = the original `paid_at` in Israel time; the refund PDF reuses the number and is dated `refunded_at`, else today; built by the same `buildReceipt` helper as the e-mailed receipt). `?sweep=1` (POST) → send the abandonment report now (shorter grace: 10 minutes minimum). `?thankyou=1` (POST) → send
   post-event thank-yous for the last 2 days (manual backup for the daily cron). PATCH `?slug=` `{active}`
   → activate/deactivate; PATCH `?slug=` `{refunded}` → set/clear `refunded_at` (marker only; `active` untouched; 409 "migration needed" before the migration); a PATCH with neither field is 400. DELETE `?slug=` → delete event + rsvps. The page's revenue figure = ₪99 × paid events with `refunded_at` NULL.
9. **cleanup.js** — cron, Bearer `CRON_SECRET`. Runs the abandonment sweep + retention: 30 days after
   the event date it **closes** paid events (writes the `final_*` snapshot if none exists yet, deletes guest
   RSVPs, sets `active=false`, keeps the event + receipt record; a reactivated closed event is closed
   again with its snapshot kept) and **deletes** unpaid past drafts outright, and purges `rate_limits` rows older than a day. Scheduled daily 02:00
   (`vercel.json` cron `0 2 * * *`).

**Helpers:** `_receipt.js` = `generateReceiptPDF({receiptNumber, customerName, paymentDate, isRefund})`
(Hebrew A5 PDF, business "Kupernet", עוסק פטור 036409084) plus `buildReceipt(supabase, event, {isRefund})`, `receiptNumberFor`, `formatPaymentDate` (the single source of the receipt data). `_pay.js` = price constant (`PRICE_ILS` 99, `CURRENCY`), order signing (`makeCustomId`, `parseCustomId`), `ORDER_ID_RE`. `_mail.js` = `esc`, `oneLine` (every caller text in an e-mail goes through `esc`). `_ratelimit.js` = Supabase-backed limiter (`overLimit`, `clientIp`, `originVerdict`; hashed keys; fails open). `_sweep.js` =
`sweepAbandonedCheckouts({graceMinutes, ignoreGrace})` (cron 20 min grace; manual 10 min minimum) → skips
buyers who paid since the checkout (`paidSincePending`), sends each remaining buyer a recovery email (link
to their saved draft when found, never a password) + ONE owner digest, logs one anonymous
`checkout_abandonments` row per reported checkout, marks all swept rows `notified`, purges pending rows
>7 days old. `_recovery.js` = pure helpers `esc`, `paidSincePending`, `pickDraft`, `buildRecoveryHtml`.

## Payment flow (create-then-pay)
1. Wizard fills form → on reaching step 3, `create-event` saves an **unpaid draft** and emails the
   organizer their dashboard link/password (the page also keeps the password in memory to prove ownership at create-order).
2. Step 3 shows a live guest-page preview + PayPal "publish" button.
3. Paying → create-order (signed, ownership proved with the draft password) → `paypal-capture` verifies the order, then publish mode sets `paid_at` → event goes live → redirect to `/success?slug=`.
4. Can also return later via the emailed **dashboard link**, which shows a publish screen (its own PayPal button) for unpaid drafts.

## Emails (Brevo; sender "אישורי הגעה" <kupernetservice@gmail.com>)
- **Draft saved** → organizer, on create-event.
- **Confirmation + receipt PDF** → organizer, on publish.
- **Owner order notification** → `kuperoy@gmail.com`, on publish.
- **Failed-payment alert** → `kuperoy@gmail.com`, on capture failure (includes PayPal reason).
- **Abandonment**: owner **digest** (one email listing the reported checkouts; buyers who paid later are left out and mentioned in a note) + per-customer **recovery** email (from "רועי", link to the saved draft + WhatsApp, no password).
- **Post-event thank-you** → organizer, 1 day after the event date (cron, paid events only, from "רועי"), asking for feedback/testimonial.

Owner/admin alerts → **kuperoy@gmail.com**. Public support/contact address → **kupernetservice@gmail.com**.

## i18n & theme
- `theme.js` (shared): dark-mode + language toggle. Default **Hebrew** + light (persisted in localStorage `lang`/`theme`).
- Pages define `window.PAGE_I18N = {he,en}` to enable the EN/עב toggle; tag elements with
  `data-i18n="key"` (textContent) / `data-i18n-ph="key"` (placeholder). Use `window.t(key)`, `getLang()`;
  re-render dynamic content on the `langchange` event. `html` dir/lang flip automatically.
- **Bilingual (he+en):** index, register, rsvp, dashboard, success, pricing.
- **Hebrew + dark-mode only (no EN):** admin, tos, privacy, refund.
- `style.css`: dark mode via `html.dark`; LTR fixes via `html[dir="ltr"]`.

## Pages (`public/`)
`index.html` (landing: promo banner + trust line with the linked refund sentence + testimonials + WhatsApp + gtag), `register.html`
(3-step wizard, draft creation, rich preview, PayPal publish, trust signals), `dashboard.html`
(owner; publish screen if unpaid, RSVP table/stats/CSV/edit if paid; sessionStorage auto-login per slug),
`rsvp.html` (guest), `success.html` (checks the event is paid with `GET /api/event/<slug>`; fires the gtag purchase conversion, 99 ILS, `transaction_id` = slug, only when this tab holds the fresh `rsvp_paid` marker set by the pay page), `admin.html`
(super-admin, Hebrew, light/dark toggle, Ended badge, abandoned-checkout stat), `pricing/tos/privacy/refund.html`, `style.css`, `theme.js`, `favicon.svg`.

## Business rules
- Price **₪99** one-time per event (ILS). PayPal live, `locale=he_IL`.
- **Retention:** 30 days after the event date, guest RSVP lists are deleted (privacy); the paid event's
  record + receipt are kept in admin (`active=false` = "closed") with `final_responses`/`final_guests`
  headcounts snapshotted first (snapshot written once; a reactivated closed event is re-closed by the next cron with the saved headcount kept and any new replies deleted). Unpaid drafts are deleted. Policy pages reflect this ("guest list deleted, event/receipt kept").
- Refund policy: full refund within **14 days if no RSVPs collected** (`refund.html`).
- Abandonment grace: **20 min** (daily cron). Admin "send report" button uses a shorter grace with a **10-minute minimum**.
- **Event types** (value → Hebrew): bar_mitzvah בר מצווה, bat_mitzvah בת מצווה, wedding חתונה,
  brit ברית מילה, brit_bat בריתה, birthday יום הולדת, bachelor מסיבת רווקים, bachelorette מסיבת רווקות,
  henna חינה, family אירוע משפחתי, other אחר.
- **Slug** = `{typePrefix}-{translit(lastname)}-{year}`, `+` random hex on collision.

## Marketing
- Google Ads "RSVP Search Campaign" (Search). gtag id `AW-18293655759`; purchase conversion label
  `t6piCIOmuMkcEM-RjJNE` fires on success.html. Negative keywords added: חינם/בחינם/חינמי/אקסל/תבנית/תבניות/וורד/free/template/excel.
- Ads agent (`automation/`, n8n, daily 05:00): ₪13/day pin, ₪400/month cap, max 8 changes per run; auto-resumes only its own cap pause (Google Ads change history), never a campaign paused by hand.

## Gotchas (for the assistant)
- **This sandbox cannot reach `supabase.co` or `paypal.com` directly** (network block). Test via
  `rsvp.kupernet.com/api/...` endpoints, which are reachable.
- Deploy only from `/Users/rkuperman/rsvp-platform` (cwd resets between bash calls — always `cd` first).
- Vercel Hobby crons run at most **once per day**.
- Never put secrets in code, git, or chat. Credentials pasted in chat must be rotated.
- `.atreides/` (run folders, customer data) is gitignored and in `.vercelignore`; never commit or upload it.
