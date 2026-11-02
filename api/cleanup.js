const { createClient } = require("@supabase/supabase-js");
const { sweepAbandonedCheckouts, sendPostEventThankYous } = require("./_sweep");

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

  // 2. Close paid past events that are still open: snapshot final counts, then delete guest RSVPs,
  //    keep the record. The snapshot preserves headcounts for tracking without keeping personal data.
  //    The snapshot is written once: an event that already has one (closed before, then reactivated by
  //    the owner) is closed again with its saved headcount kept.
  const { data: paidOld, error: pErr } = await supabase
    .from("events").select("id, final_responses, final_guests").lt("gregorian_date", cutoff).not("paid_at", "is", null).eq("active", true);
  if (pErr) throw pErr;
  let closed = 0;
  if (paidOld && paidOld.length) {
    for (const ev of paidOld) {
      const { data: rs } = await supabase
        .from("rsvps").select("attending, guests").eq("event_id", ev.id);
      const rows = rs || [];
      const hasSnapshot = ev.final_responses != null || ev.final_guests != null;
      if (hasSnapshot) {
        // Closed before and reactivated by the owner ("▶️ הפעל" in /admin): close it again but never
        // overwrite the saved headcount (its replies were deleted at the first close, so a recount gives 0/0).
        // Replies received while it was reactivated are deleted below and not added to the count.
        await supabase.from("events").update({ active: false }).eq("id", ev.id);
        if (rows.length) console.warn(`cleanup: event ${ev.id} kept its saved headcount; deleted ${rows.length} reply(ies) received after reactivation`);
      } else {
        const finalResponses = rows.length;
        const finalGuests = rows.filter(r => r.attending).reduce((s, r) => s + (r.guests || 0), 0);
        await supabase.from("events").update({
          active: false,
          final_responses: finalResponses,
          final_guests: finalGuests,
        }).eq("id", ev.id);
      }
      await supabase.from("rsvps").delete().eq("event_id", ev.id);
    }
    closed = paidOld.length;
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
