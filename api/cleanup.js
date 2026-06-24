const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  // Vercel cron jobs send Authorization: Bearer <CRON_SECRET>
  const auth = req.headers.authorization || "";
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Find events whose date was more than 1 month ago
    const { data: oldEvents, error: fetchErr } = await supabase
      .from("events")
      .select("id")
      .lt("gregorian_date", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));

    if (fetchErr) throw fetchErr;
    if (!oldEvents || oldEvents.length === 0) {
      return res.status(200).json({ deleted: 0 });
    }

    const ids = oldEvents.map(e => e.id);

    // Delete RSVPs first (in case no CASCADE FK)
    const { error: rsvpErr } = await supabase
      .from("rsvps")
      .delete()
      .in("event_id", ids);
    if (rsvpErr) throw rsvpErr;

    // Delete events
    const { error: evErr } = await supabase
      .from("events")
      .delete()
      .in("id", ids);
    if (evErr) throw evErr;

    console.log(`Cleanup: deleted ${ids.length} old event(s)`);
    return res.status(200).json({ deleted: ids.length });
  } catch (err) {
    console.error("cleanup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
