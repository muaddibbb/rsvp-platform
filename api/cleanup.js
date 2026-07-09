const { createClient } = require("@supabase/supabase-js");
const { sweepAbandonedCheckouts } = require("./_sweep");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
