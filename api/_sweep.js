// Shared abandoned-checkout sweep, used by both the daily cron (cleanup.js)
// and the manual "send now" trigger in the admin panel (admin-events.js).
// Underscore-prefixed so Vercel does not treat it as its own serverless function.
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
async function sendRecoveryEmail(p) {
  const email = (p.customer_email || "").trim();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return;
  await sendEmail(
    email,
    `אישורי הגעה לאירוע ${p.event_name || ""}`.trim(),
    `<div dir="rtl" style="font-family:Arial;font-size:15px;line-height:1.9;color:#1a1a2e;padding:8px 4px;max-width:520px">
      <p>היי, זה רועי מ <a href="https://rsvp.kupernet.com" style="color:#c9993a">rsvp.kupernet.com</a></p>
      <p>ראינו שהתחלת הרשמה לאישורי הגעה לאירוע ב99 ש״ח דרך האתר שלנו, ולא סיימת. יש משהו שאני יכול לעזור כדי להשלים?</p>
      <p>תודה.</p>
    </div>`,
    "רועי מ-rsvp.kupernet.com"
  );
}

// Email the owner about checkouts where all fields were filled but payment never completed.
// opts.graceMinutes: how long a row must be idle before it's flagged (default 20).
// opts.ignoreGrace: when true (manual trigger), report all un-notified rows regardless of age.
async function sweepAbandonedCheckouts(opts = {}) {
  const { graceMinutes = 20, ignoreGrace = false } = opts;

  let query = supabase.from("pending_checkouts").select("*").eq("notified", false);
  if (!ignoreGrace) {
    const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000).toISOString();
    query = query.lt("updated_at", cutoff);
  }
  const { data: rows, error } = await query;
  if (error) { console.error("pending fetch error:", error); return 0; }
  if (!rows || !rows.length) return 0;

  // Send each abandoning customer their own recovery email, and build one digest row per checkout.
  const digestRows = [];
  for (const p of rows) {
    await sendRecoveryEmail(p);
    const typeLabel = EVENT_TYPE_LABELS[p.event_type] || p.event_type || "—";
    digestRows.push(`<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${p.customer_name || "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${p.customer_email || "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${p.customer_phone || "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${p.event_name || "—"} (${typeLabel})</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee">${p.gregorian_date || "—"}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;white-space:nowrap">${new Date(p.updated_at).toLocaleString("he-IL")}</td>
    </tr>`);
  }

  // One consolidated report to the owner listing every abandoned checkout in this sweep.
  await sendEmail(
    "kuperoy@gmail.com",
    `🛒 דוח הרשמות שלא הושלמו — ${rows.length} ${rows.length === 1 ? "לקוח" : "לקוחות"}`,
    `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:720px">
      <h2 style="color:#1a2744">הרשמות שלא הושלמו 🛒</h2>
      <p>${rows.length} לקוחות מילאו את כל הפרטים אך לא השלימו תשלום. כל אחד קיבל אימייל אוטומטי עם הצעת עזרה.</p>
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
  return rows.length;
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
