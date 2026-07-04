const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const generateReceiptPDF = require("./_receipt");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function authorized(req) {
  const header = req.headers["authorization"] || "";
  const token  = header.replace(/^Bearer\s+/i, "");
  const pass   = process.env.ADMIN_PASSWORD || "";
  if (!pass || !token) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(pass));
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });

  // GET ?receipt=1&slug=xxx or ?refund=1&slug=xxx — download receipt/refund PDF
  if (req.method === "GET" && (req.query.receipt || req.query.refund)) {
    const isRefund = !!req.query.refund;
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    const { data: event } = await supabase
      .from("events")
      .select("customer_name, paid_at")
      .eq("slug", slug)
      .maybeSingle();
    if (!event) return res.status(404).json({ error: "Event not found" });

    const { count } = await supabase
      .from("events")
      .select("*", { count: "exact", head: true })
      .lte("paid_at", event.paid_at);

    const pdfBuffer = await generateReceiptPDF({
      receiptNumber: count || 1,
      customerName:  event.customer_name,
      paymentDate:   new Date().toLocaleDateString("he-IL"),
      isRefund,
    });

    const filename = `${isRefund ? "זיכוי" : "קבלה"}-${slug}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.status(200).end(pdfBuffer);
  }

  // PATCH ?slug=xxx {active: true/false} — activate/deactivate event
  if (req.method === "PATCH") {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: "Missing slug" });
    const active = !!(req.body || {}).active;

    const { error } = await supabase.from("events").update({ active }).eq("slug", slug);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ slug, active });
  }

  // GET — list all events with RSVP counts
  if (req.method === "GET") {
    const { data: events, error } = await supabase
      .from("events")
      .select("id, slug, event_name, event_type, gregorian_date, event_time, location, customer_name, customer_email, dashboard_password, paid_at, active, rsvps(count)")
      .order("paid_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const rows = events.map(e => ({
      ...e,
      rsvp_count: e.rsvps?.[0]?.count ?? 0,
      rsvps: undefined,
    }));

    return res.status(200).json({ events: rows });
  }

  // DELETE ?slug=xxx — remove event and its RSVPs
  if (req.method === "DELETE") {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: "Missing slug" });

    const { data: event } = await supabase
      .from("events").select("id").eq("slug", slug).maybeSingle();
    if (!event) return res.status(404).json({ error: "Event not found" });

    await supabase.from("rsvps").delete().eq("event_id", event.id);
    const { error } = await supabase.from("events").delete().eq("id", event.id);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ deleted: slug });
  }

  return res.status(405).end();
};
