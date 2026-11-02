// Shared abandoned-checkout sweep, used by both the daily cron (cleanup.js)
// and the manual "send now" trigger in the admin panel (admin-events.js).
// Underscore-prefixed so Vercel does not treat it as its own serverless function.
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const { esc, paidSincePending, pickDraft, buildRecoveryHtml } = require("./_recovery");
const BASE_URL = process.env.BASE_URL || "https://rsvp.kupernet.com";

const EVENT_TYPE_LABELS = {
  bar_mitzvah:"בר מצווה", bat_mitzvah:"בת מצווה", wedding:"חתונה",
  brit:"ברית מילה", brit_bat:"בריתה", birthday:"יום הולדת",
  bachelor:"מסיבת רווקים", bachelorette:"מסיבת רווקות",
  henna:"חינה", family:"אירוע משפחתי", other:"אחר",
};

async function sendEmail(to, subject, html, fromName = "אישורי הגעה") {
  if (!process.env.BREVO_API_KEY) return;
  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender:  { name: fromName, email: "kupernetservice@gmail.com" },
      replyTo: { name: fromName, email: "kupernetservice@gmail.com" },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  }).catch(e => console.error("Brevo error:", e));
}

// Friendly recovery email sent to the customer who started but didn't finish checkout.
// `draft` (their own unpaid event, if found) adds a link back to it; the email never carries a password.
async function sendRecoveryEmail(p, draft) {
  const email = (p.customer_email || "").trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return;
  await sendEmail(
    email,
    `אישורי הגעה לאירוע ${p.event_name || ""}`.trim(),
    buildRecoveryHtml(p, draft, BASE_URL),
    "רועי מ-rsvp.kupernet.com"
  );
}

// Email the owner about checkouts where all fields were filled but payment never completed.
// opts.graceMinutes: how long a row must be idle before it's flagged (default 20).
// opts.ignoreGrace: when true (manual trigger), use a shorter grace with a 10-minute floor (a smaller
// graceMinutes is raised to 10, a larger one is kept), so buyers still mid-checkout are not emailed.
async function sweepAbandonedCheckouts(opts = {}) {
  const { graceMinutes, ignoreGrace = false } = opts;

  let query = supabase.from("pending_checkouts").select("*").eq("notified", false);
  const requested = Number.isFinite(graceMinutes) ? graceMinutes : null;
  // Manual trigger: never shorter than 10 minutes (a longer value from the caller is respected, none means 10).
  const effectiveGrace = ignoreGrace ? Math.max(10, requested === null ? 10 : requested) : (requested === null ? 20 : requested);
  query = query.lt("updated_at", new Date(Date.now() - effectiveGrace * 60 * 1000).toISOString());
  const { data: rows, error } = await query;
  if (error) { console.error("pending fetch error:", error); return 0; }
  if (!rows || !rows.length) return 0;

  // Send each abandoning customer their own recovery email, and build one digest row per checkout.
  // A buyer who already paid (e.g. on the dashboard) gets no email and no digest row.
  const digestRows = [];
  const paidRows = [];
  for (const p of rows) {
    const email = (p.customer_email || "").trim();
    let events = null; // stays null if the lookup fails: the email goes out without a link
    if (/^\S+@\S+\.\S+$/.test(email)) {
      const { data, error: evErr } = await supabase
        .from("events")
        .select("slug, event_name, gregorian_date, paid_at, active")
        .eq("customer_email", email) // .eq is exact on purpose: ilike treats "_" in an email as a wildcard
        .limit(20);
      if (evErr) console.error("recovery lookup error:", evErr);
      else events = data || [];
    }
    if (events && paidSincePending(p, events)) { paidRows.push(p); continue; }
    await sendRecoveryEmail(p, events ? pickDraft(p, events) : null);
    // Permanent, anonymous record (no name/email/phone) so abandonment counts survive the
    // 7-day PII purge below — logged here, the moment a checkout is confirmed abandoned.
    await supabase.from("checkout_abandonments").insert({
      abandoned_at: new Date().toISOString(),
      event_type: p.event_type || null,
    });
    const typeLabel = EVENT_TYPE_LABELS[p.event_type] || p.event_type || "—";
    digestRows.push(`<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(p.customer_name || "—")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(p.customer_email || "—")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(p.customer_phone || "—")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(p.event_name || "—")} (${esc(typeLabel)})</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${esc(p.gregorian_date || "—")}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap">${esc(new Date(p.updated_at).toLocaleString("he-IL"))}</td>
    </tr>`);
  }

  const paidNote = paidRows.length
    ? `<p style="color:#6b7280;font-size:.85rem">${paidRows.length === 1 ? "(עוד לקוח אחד השלים תשלום מאוחר יותר ולא נספר)" : `(${paidRows.length} נוספים השלימו תשלום מאוחר יותר ולא נספרו)`}</p>`
    : "";

  // One consolidated report to the owner listing every abandoned checkout in this sweep.
  if (digestRows.length > 0) await sendEmail(
    "kuperoy@gmail.com",
    `🛒 דוח הרשמות שלא הושלמו — ${digestRows.length} ${digestRows.length === 1 ? "לקוח" : "לקוחות"}`,
    `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:720px">
      <h2 style="color:#1a2744">הרשמות שלא הושלמו 🛒</h2>
      <p>${digestRows.length} לקוחות מילאו את כל הפרטים אך לא השלימו תשלום. כל אחד קיבל אימייל אוטומטי עם הצעת עזרה.</p>${paidNote}
      <table style="border-collapse:collapse;width:100%;font-size:14px;margin-top:12px">
        <thead>
          <tr style="background:#1a2744;color:#fff">
            <th style="padding:8px 10px;text-align:right">לקוח</th>
            <th style="padding:8px 10px;text-align:right">אימייל</th>
            <th style="padding:8px 10px;text-align:right">טלפון</th>
            <th style="padding:8px 10px;text-align:right">אירוע</th>
            <th style="padding:8px 10px;text-align:right">תאריך האירוע</th>
            <th style="padding:8px 10px;text-align:right">הגיע לתשלום</th>
          </tr>
        </thead>
        <tbody>${digestRows.join("")}</tbody>
      </table>
    </div>`
  );

  // Mark all as notified in one batch so they aren't reported again
  await supabase.from("pending_checkouts")
    .update({ notified: true })
    .in("id", rows.map(r => r.id));

  // Purge fully-aged rows (7+ days) to keep the table small
  await supabase.from("pending_checkouts")
    .delete()
    .lt("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  return digestRows.length;
}

// One day after the event, thank the organizer and ask for feedback (paid events only).
// Default matches events dated exactly "yesterday". A manual run can pass windowDays>1
// to also catch events from the last few days (e.g. if a cron run was missed).
async function sendPostEventThankYous(windowDays = 1) {
  const today = new Date();
  const startYmd = new Date(today.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const endYmd   = new Date(today.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: events, error } = await supabase
    .from("events")
    .select("customer_name, customer_email, event_name")
    .gte("gregorian_date", startYmd)
    .lte("gregorian_date", endYmd)
    .not("paid_at", "is", null);
  if (error) { console.error("thank-you fetch error:", error); return 0; }
  if (!events || !events.length) return 0;

  let sent = 0;
  for (const e of events) {
    if (!e.customer_email) continue;
    await sendEmail(
      e.customer_email,
      `תודה שבחרת ב-rsvp.kupernet.com 🎉`,
      `<div dir="rtl" style="font-family:Arial;font-size:15px;line-height:1.9;color:#1a1a2e;padding:8px 4px;max-width:520px">
        <p>היי, כאן רועי מהאתר <a href="https://rsvp.kupernet.com" style="color:#c9993a">rsvp.kupernet.com</a>.</p>
        <p>תודה שהשתמשת בשירות אישורי ההגעה לאירוע של rsvp.kupernet.com</p>
        <p>נשמח לשמוע ממך חוות דעת על המוצר שלנו, הצעות לשיפור (וכמובן, מחמאות יתקבלו בברכה...)</p>
        <p>המון מזל טוב, ונתראה באירוע הבא 🎉</p>
      </div>`,
      "רועי מ-rsvp.kupernet.com"
    );
    sent++;
  }
  return sent;
}

module.exports = { sweepAbandonedCheckouts, sendEmail, sendPostEventThankYous };
