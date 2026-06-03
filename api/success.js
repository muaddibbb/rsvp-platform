const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: "Missing session_id" });

  try {
    // Poll DB up to 5s for the webhook to finish writing
    let event = null;
    for (let i = 0; i < 10; i++) {
      const { data } = await supabase
        .from("events")
        .select("slug, event_name, customer_name")
        .eq("stripe_session_id", session_id)
        .maybeSingle();
      if (data) { event = data; break; }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!event) return res.status(202).json({ pending: true });
    res.status(200).json(event);
  } catch (err) {
    console.error("success endpoint error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
