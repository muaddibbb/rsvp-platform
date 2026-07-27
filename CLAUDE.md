# Kupernet RSVP Platform — Reference

Hebrew-first (RTL) RSVP SaaS at **rsvp.kupernet.com**. One-time **₪99** per event.
This file is the source of truth for how the system works — consult it before digging through code.
Keep it updated when behavior changes.

## Stack & hosting
- **Frontend:** static HTML/CSS/JS in `public/` (no framework/build).
- **Backend:** Vercel serverless functions in `api/` (Node.js, CommonJS `module.exports`).
- **DB:** Supabase (Postgres). **Email:** Brevo API. **Payments:** PayPal REST v2 (LIVE). **PDF:** PDFKit.
- **Deploy:** `cd /Users/rkuperman/rsvp-platform && npx vercel --prod` (personal Vercel team `kupernet`, project `rsvp-platform`). Domain `rsvp.kupernet.com`. Deployment protection is OFF.
- **Function limit:** Vercel Hobby = 12. Currently **9** functions. Files in `api/` starting with `_` are shared helpers, NOT functions.
- **Repo:** github.com/muaddibbb/rsvp-platform (`main`).

## Environment variables (names only — never store values here)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BREVO_API_KEY`, `PAYPAL_CLIENT_ID`,
`PAYPAL_SECRET`, `PAYPAL_SANDBOX` (="false" → live), `ADMIN_PASSWORD`, `CRON_SECRET`,
`BASE_URL` (optional, defaults to https://rsvp.kupernet.com).

## Data model (Supabase)
- **events**: `id` (uuid), `slug` (unique text), `customer_name/email/phone`, `event_type`,
  `event_name`, `hebrew_date`, `gregorian_date` (date), `event_time`, `location`, `address`,
  `extra_note`, `dashboard_password`, `paid_at` (timestamptz — **NULL = unpaid draft**),
  `active` (bool, default true — false = deactivated/hidden).
- **rsvps**: `id`, `event_id` (fk), `name`, `attending` (bool), `guests` (int), `notes`, `created_at`.
- **pending_checkouts**: `id` (text = client checkoutId), `customer_*`, `event_*`, `location`,
  `updated_at`, `notified` (bool). Tracks "reached checkout, not yet paid".

**Visibility rule:** guests only ever see events where `paid_at IS NOT NULL AND active != false`.
Unpaid drafts and deactivated events return 404 to guests.

## API functions (`api/`)
1. **create-event.js** — POST. Creates an **unpaid draft** (`paid_at=null`), generates slug +
   `dashboard_password`, emails the organizer their dashboard link. Returns `{slug, dashboard_password}`. Unauthenticated (drafts are invisible/harmless).
2. **paypal-config.js** — GET → `{clientId}` for the SDK. `?test=1` (admin Bearer) = credential diagnostic.
3. **paypal-create-order.js** — POST → creates a ₪99 ILS order, returns `{id}`.
4. **paypal-capture.js** — POST. Modes:
   - `?pending=1` + `{checkoutId,...}` → upsert a `pending_checkouts` row (reached-checkout beacon).
   - default → capture payment. If body has `slug` → **PUBLISH mode** (update that draft, apply final
     edits, set `paid_at=now`). Else **legacy create** (insert a fresh paid event). On capture failure
     → emails owner a failed-payment alert with PayPal reason. On success → deletes the pending row,
     sends confirmation + receipt + owner order-notification. Returns `{slug, event_name, dashboard_password}`.
5. **dashboard/[slug].js** — password-gated (`dashboard_password`, timing-safe). Loads event whether
   paid or draft. GET → `{event(+paid flag), stats, rsvps}`. PATCH → edit event fields. DELETE → remove an rsvp.
6. **event/[slug].js** — GET public event data for the guest page (paid+active only).
7. **rsvp/[slug].js** — POST a guest RSVP (paid+active only).
8. **admin-events.js** — Bearer `ADMIN_PASSWORD`. GET = list **paid** events + rsvp counts.
   `?receipt=1&slug=` / `?refund=1&slug=` → PDF. `?sweep=1` (POST) → send abandonment report now
   (ignores grace). PATCH `?slug=` `{active}` → activate/deactivate. DELETE `?slug=` → delete event + rsvps.
9. **cleanup.js** — cron, Bearer `CRON_SECRET`. Runs the abandonment sweep + retention: 30 days after
   the event date it **closes** paid events (deletes guest RSVPs, sets `active=false`, keeps the event +
   receipt record for admin) and **deletes** unpaid past drafts outright. Scheduled daily 02:00
   (`vercel.json` cron `0 2 * * *`).

**Helpers:** `_receipt.js` = `generateReceiptPDF({receiptNumber, customerName, paymentDate, isRefund})`
(Hebrew A5 PDF, business "Kupernet", עוסק פטור 036409084). `_sweep.js` =
`sweepAbandonedCheckouts({graceMinutes=20, ignoreGrace})` → per-customer recovery email + ONE owner
digest, marks `notified`, purges pending rows >7 days old.

## Payment flow (create-then-pay)
1. Wizard fills form → on reaching step 3, `create-event` saves an **unpaid draft** and emails the
   organizer their dashboard link/password.
2. Step 3 shows a live guest-page preview + PayPal "publish" button.
3. Paying → `paypal-capture` publish mode sets `paid_at` → event goes live → redirect to `/success?slug=`.
4. Can also return later via the emailed **dashboard link**, which shows a publish screen (its own PayPal button) for unpaid drafts.

## Emails (Brevo; sender "אישורי הגעה" <kupernetservice@gmail.com>)
- **Draft saved** → organizer, on create-event.
- **Confirmation + receipt PDF** → organizer, on publish.
- **Owner order notification** → `kuperoy@gmail.com`, on publish.
- **Failed-payment alert** → `kuperoy@gmail.com`, on capture failure (includes PayPal reason).
- **Abandonment**: owner **digest** (one email listing all) + per-customer **recovery** email (from "רועי").

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
`index.html` (landing: promo banner + money-back badge + trust line + gtag), `register.html`
(3-step wizard, draft creation, rich preview, PayPal publish, trust signals), `dashboard.html`
(owner; publish screen if unpaid, RSVP table/stats/CSV/edit if paid; sessionStorage auto-login per slug),
`rsvp.html` (guest), `success.html` (gtag purchase conversion value 99 ILS), `admin.html`
(super-admin, Hebrew, dark-only), `pricing/tos/privacy/refund.html`, `style.css`, `theme.js`, `favicon.svg`.

## Business rules
- Price **₪99** one-time per event (ILS). PayPal live, `locale=he_IL`.
- **Retention:** 30 days after the event date, guest RSVP lists are deleted (privacy), but the paid
  event's record + receipt are kept in admin (event set to `active=false` = "closed"). Unpaid drafts are deleted.
- Refund policy: full refund within **14 days if no RSVPs collected** (`refund.html`).
- Abandonment grace: **20 min** (daily cron). Admin "send report" button ignores grace.
- **Event types** (value → Hebrew): bar_mitzvah בר מצווה, bat_mitzvah בת מצווה, wedding חתונה,
  brit ברית מילה, brit_bat בריתה, birthday יום הולדת, bachelor מסיבת רווקים, bachelorette מסיבת רווקות,
  henna חינה, family אירוע משפחתי, other אחר.
- **Slug** = `{typePrefix}-{translit(lastname)}-{year}`, `+` random hex on collision.

## Marketing
- Google Ads "RSVP Search Campaign" (Search). gtag id `AW-18293655759`; purchase conversion label
  `t6piCIOmuMkcEM-RjJNE` fires on success.html. Negative keywords added: חינם/בחינם/חינמי/אקסל/תבנית/תבניות/וורד/free/template/excel.

## Gotchas (for the assistant)
- **This sandbox cannot reach `supabase.co` or `paypal.com` directly** (network block). Test via
  `rsvp.kupernet.com/api/...` endpoints, which are reachable.
- Deploy only from `/Users/rkuperman/rsvp-platform` (cwd resets between bash calls — always `cd` first).
- Vercel Hobby crons run at most **once per day**.
- Never put secrets in code, git, or chat. Credentials pasted in chat must be rotated.
- **Policy wording note:** tos.html / privacy.html / pricing FAQ still say "all event AND guest data
  deleted after a month." Reality now: guest data deleted, but the paid event/receipt record is kept.
  Update that wording for accuracy when convenient.
