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
async function sweepAbandonedCheckouts() {
  // Grace period: only flag checkouts idle for 20+ minutes, so we don't email someone mid-payment.
  const cutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data: rows, error } = await supabase
    .from("pending_checkouts")
    .select("*")
    .eq("notified", false)
    .lt("updated_at", cutoff);
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

// Delete events whose date passed more than a month ago (data-retention policy).
async function purgeOldEvents() {
  const { data: oldEvents, error: fetchErr } = await supabase
    .from("events")
    .select("id")
    .lt("gregorian_date", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  if (fetchErr) throw fetchErr;
  if (!oldEvents || !oldEvents.length) return 0;

  const ids = oldEvents.map(e => e.id);
  const { error: rsvpErr } = await supabase.from("rsvps").delete().in("event_id", ids);
  if (rsvpErr) throw rsvpErr;
  const { error: evErr } = await supabase.from("events").delete().in("id", ids);
  if (evErr) throw evErr;
  return ids.length;
}

module.exports = async (req, res) => {
  // Vercel cron jobs send Authorization: Bearer <CRON_SECRET>
  const auth = req.headers.authorization || "";
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const abandoned = await sweepAbandonedCheckouts();
    const deleted   = await purgeOldEvents();
    console.log(`Cleanup: deleted ${deleted} old event(s), notified ${abandoned} abandoned checkout(s)`);
    return res.status(200).json({ deleted, abandoned });
  } catch (err) {
    console.error("cleanup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
