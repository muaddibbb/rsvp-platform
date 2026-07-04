const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "Missing slug" });

  try {
    const { data, error } = await supabase
      .from("events")
      .select("id, event_type, event_name, hebrew_date, gregorian_date, event_time, location, address, extra_note")
      .eq("slug", slug)
      .not("paid_at", "is", null)
      .neq("active", false)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "אירוע לא נמצא" });

    res.status(200).json(data);
  } catch (err) {
    console.error("event/[slug] error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
