const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { slug } = req.query;
  const body = req.body || {};

  // Validate
  const name      = String(body.name || "").trim().slice(0, 100);
  const attending = body.attending === true || body.attending === "true" || body.attending === "yes";
  const guests    = attending ? Math.min(Math.max(parseInt(body.guests) || 1, 1), 20) : 0;
  const notes     = String(body.notes || "").trim().slice(0, 500);

  if (!name) return res.status(400).json({ error: "שם חסר" });

  try {
    // Find event by slug
    const { data: event, error: evErr } = await supabase
      .from("events")
      .select("id")
      .eq("slug", slug)
      .not("paid_at", "is", null)
      .maybeSingle();

    if (evErr) throw evErr;
    if (!event) return res.status(404).json({ error: "אירוע לא נמצא" });

    // Insert RSVP
    const { error: rsvpErr } = await supabase.from("rsvps").insert({
      event_id:  event.id,
      name,
      attending,
      guests,
      notes:     notes || null,
    });

    if (rsvpErr) throw rsvpErr;

    console.log(`RSVP: ${name} → ${attending ? "מגיע" : "לא מגיע"} (${guests}) @ ${slug}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("rsvp/[slug] error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
