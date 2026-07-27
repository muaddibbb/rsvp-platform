const { createClient } = require("@supabase/supabase-js");
const { sweepAbandonedCheckouts, sendEmail } = require("./_sweep");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// One day after the event date, thank the organizer and ask for feedback.
// Matches events dated exactly "yesterday" so the daily cron sends each once (no flag needed).
async function sendPostEventThankYous() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: events, error } = await supabase
    .from("events")
    .select("customer_name, customer_email, event_name")
    .eq("gregorian_date", yesterday)
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

// 30 days after the event date:
//  - Paid events → "close" them: purge the guest RSVP lists (personal data, per the
//    privacy policy) but KEEP the event record (closed/active=false) so the owner can
//    still track past events and download receipts in the admin panel.
//  - Unpaid drafts → delete entirely (junk that never became a real event).
async function closeOrPurgeOldEvents() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 1. Delete unpaid past drafts outright.
  const { data: drafts, error: dErr } = await supabase
    .from("events").select("id").lt("gregorian_date", cutoff).is("paid_at", null);
  if (dErr) throw dErr;
  let deletedDrafts = 0;
  if (drafts && drafts.length) {
    const dids = drafts.map(e => e.id);
    await supabase.from("rsvps").delete().in("event_id", dids);
    const { error } = await supabase.from("events").delete().in("id", dids);
    if (error) throw error;
    deletedDrafts = dids.length;
  }

  // 2. Close paid past events that are still open: delete guest RSVPs, keep the record.
  const { data: paidOld, error: pErr } = await supabase
    .from("events").select("id").lt("gregorian_date", cutoff).not("paid_at", "is", null).eq("active", true);
  if (pErr) throw pErr;
  let closed = 0;
  if (paidOld && paidOld.length) {
    const pids = paidOld.map(e => e.id);
    await supabase.from("rsvps").delete().in("event_id", pids);
    const { error } = await supabase.from("events").update({ active: false }).in("id", pids);
    if (error) throw error;
    closed = pids.length;
  }

  return { deletedDrafts, closed };
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
    const thanked   = await sendPostEventThankYous();
    const { deletedDrafts, closed } = await closeOrPurgeOldEvents();
    console.log(`Cleanup: thanked ${thanked}, closed ${closed} past event(s), deleted ${deletedDrafts} stale draft(s), notified ${abandoned} abandoned checkout(s)`);
    return res.status(200).json({ thanked, closed, deletedDrafts, abandoned });
  } catch (err) {
    console.error("cleanup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
