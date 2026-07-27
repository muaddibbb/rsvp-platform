const { createClient } = require("@supabase/supabase-js");
const { sweepAbandonedCheckouts } = require("./_sweep");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    const { deletedDrafts, closed } = await closeOrPurgeOldEvents();
    console.log(`Cleanup: closed ${closed} past event(s), deleted ${deletedDrafts} stale draft(s), notified ${abandoned} abandoned checkout(s)`);
    return res.status(200).json({ closed, deletedDrafts, abandoned });
  } catch (err) {
    console.error("cleanup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
