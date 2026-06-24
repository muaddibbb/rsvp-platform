const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function timingSafeEqual(a, b) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
      // Still run the comparison to avoid timing leak
      crypto.timingSafeEqual(ba, ba);
      return false;
    }
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();

  const { slug } = req.query;
  const password = req.query.password || (req.body && req.body.password) || "";

  if (!slug) return res.status(400).json({ error: "Missing slug" });
  if (!password) return res.status(401).json({ error: "סיסמה נדרשת" });

  try {
    // Fetch event
    const { data: event, error: evErr } = await supabase
      .from("events")
      .select("id, event_name, event_type, hebrew_date, gregorian_date, event_time, location, address, extra_note, dashboard_password")
      .eq("slug", slug)
      .not("paid_at", "is", null)
      .maybeSingle();

    if (evErr) throw evErr;
    if (!event) return res.status(404).json({ error: "אירוע לא נמצא" });

    if (!timingSafeEqual(event.dashboard_password, password)) {
      return res.status(401).json({ error: "סיסמה שגויה" });
    }

    // --- GET: fetch RSVPs ---
    if (req.method === "GET") {
      const { data: rsvps, error: rErr } = await supabase
        .from("rsvps")
        .select("id, name, attending, guests, notes, created_at")
        .eq("event_id", event.id)
        .order("created_at", { ascending: true });

      if (rErr) throw rErr;

      const attending = rsvps.filter(r => r.attending);
      const totalGuests = attending.reduce((s, r) => s + (r.guests || 0), 0);

      return res.status(200).json({
        event: {
          event_name:     event.event_name,
          event_type:     event.event_type,
          hebrew_date:    event.hebrew_date,
          gregorian_date: event.gregorian_date,
          event_time:     event.event_time,
          location:       event.location,
          address:        event.address,
          extra_note:     event.extra_note,
        },
        stats: {
          total:       rsvps.length,
          attending:   attending.length,
          notAttending: rsvps.length - attending.length,
          totalGuests,
        },
        rsvps: rsvps.map(r => ({
          id:        r.id,
          name:      r.name,
          attending: r.attending ? "yes" : "no",
          guests:    r.guests,
          notes:     r.notes || "",
          timestamp: new Date(r.created_at).toLocaleString("he-IL"),
        })),
      });
    }

    // --- PATCH: update event details ---
    if (req.method === "PATCH") {
      const allowed = ["event_name", "hebrew_date", "gregorian_date", "event_time", "location", "address", "extra_note"];
      const body = req.body || {};
      const updates = {};
      for (const field of allowed) {
        if (field in body) updates[field] = body[field] || null;
      }
      if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: "No fields to update" });

      const { error: uErr } = await supabase.from("events").update(updates).eq("id", event.id);
      if (uErr) throw uErr;
      return res.status(200).json({ ok: true });
    }

    // --- DELETE: remove an RSVP ---
    if (req.method === "DELETE") {
      const rsvpId = req.query.id || (req.body && req.body.id);
      if (!rsvpId) return res.status(400).json({ error: "Missing RSVP id" });

      const { error: dErr } = await supabase
        .from("rsvps")
        .delete()
        .eq("id", rsvpId)
        .eq("event_id", event.id); // always scope to this event

      if (dErr) throw dErr;
      return res.status(200).json({ ok: true });
    }

    res.status(405).end();
  } catch (err) {
    console.error("dashboard/[slug] error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
