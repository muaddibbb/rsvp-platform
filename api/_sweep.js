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

async function sendEmail(to, subject, html) {
  if (!process.env.BREVO_API_KEY) return;
  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { name: "אישורי הגעה", email: "kupernetservice@gmail.com" },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  }).catch(e => console.error("Brevo error:", e));
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

  for (const p of rows) {
    const typeLabel = EVENT_TYPE_LABELS[p.event_type] || p.event_type || "—";
    await sendEmail(
      "kuperoy@gmail.com",
      `🛒 הרשמה שלא הושלמה: ${p.event_name || "ללא שם"}`,
      `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
        <h2 style="color:#1a2744">לקוח מילא את כל הפרטים אך לא השלים תשלום 🛒</h2>
        <p><strong>אירוע:</strong> ${p.event_name || "—"} (${typeLabel})<br/>
        <strong>תאריך האירוע:</strong> ${p.gregorian_date || "—"}<br/>
        <strong>לקוח:</strong> ${p.customer_name || "—"}<br/>
        <strong>אימייל:</strong> ${p.customer_email || "—"}<br/>
        <strong>טלפון:</strong> ${p.customer_phone || "—"}<br/>
        <strong>הגיע לתשלום:</strong> ${new Date(p.updated_at).toLocaleString("he-IL")}</p>
        <p style="color:#6b7280;font-size:.9rem">כדאי ליצור קשר ולעזור להם להשלים את ההרשמה.</p>
      </div>`
    );
    await supabase.from("pending_checkouts").update({ notified: true }).eq("id", p.id);
  }
  // Purge fully-aged rows (7+ days) to keep the table small
  await supabase.from("pending_checkouts")
    .delete()
    .lt("updated_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  return rows.length;
}

module.exports = { sweepAbandonedCheckouts };
