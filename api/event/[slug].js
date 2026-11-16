const { createClient } = require("@supabase/supabase-js");
const { publicUrl } = require("../_picture");

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
    const COLS = "id, event_type, event_name, hebrew_date, gregorian_date, event_time, location, address, extra_note";
    const query = (cols) => supabase
      .from("events")
      .select(cols)
      .eq("slug", slug)
      .not("paid_at", "is", null)
      .neq("active", false)
      .maybeSingle();
    let { data, error } = await query(COLS + ", picture_path");
    if (error && error.code === "42703") ({ data, error } = await query(COLS));

    if (error) throw error;
    if (!data) return res.status(404).json({ error: "אירוע לא נמצא" });

    const { picture_path, ...out } = data;
    if (typeof picture_path === "string" && picture_path.startsWith("pic/")) out.picture_url = publicUrl(picture_path);
    res.status(200).json(out);
  } catch (err) {
    console.error("event/[slug] error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
