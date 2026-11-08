const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const generateReceiptPDF = require("./_receipt");
const { buildReceipt } = generateReceiptPDF;
const { sweepAbandonedCheckouts, sendPostEventThankYous } = require("./_sweep");

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

    // Stored receipt number and refund date need the release-two migration; before it, retry with the old columns.
    let { data: event, error: evErr } = await supabase
      .from("events")
      .select("slug, customer_name, paid_at, receipt_number, refunded_at")
      .eq("slug", slug)
      .maybeSingle();
    if (evErr && evErr.code === "42703") {
      ({ data: event, error: evErr } = await supabase
        .from("events").select("slug, customer_name, paid_at").eq("slug", slug).maybeSingle());
    }
    if (evErr) { console.error("receipt lookup error:", evErr); return res.status(500).json({ error: "Database error" }); }
    if (!event) return res.status(404).json({ error: "Event not found" });
    if (!event.paid_at) return res.status(400).json({ error: "Event is not paid" });

    // The same helper builds the e-mailed receipt (paypal-capture.js): number stored once, date = the original payment.
    const pdfBuffer = await generateReceiptPDF(await buildReceipt(supabase, event, { isRefund }));

    const filename = `${isRefund ? "זיכוי" : "קבלה"}-${slug}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Content-Length", pdfBuffer.length);
    return res.status(200).end(pdfBuffer);
  }

  // POST ?sweep=1 — manually send the abandoned-checkout report now (shorter grace, 10-minute minimum)
  if (req.method === "POST" && req.query.sweep) {
    const count = await sweepAbandonedCheckouts({ ignoreGrace: true });
    return res.status(200).json({ sent: count });
  }

  // POST ?thankyou=1 — manually send post-event thank-you emails now (last 2 days of events)
  if (req.method === "POST" && req.query.thankyou) {
    const sent = await sendPostEventThankYous(2);
    return res.status(200).json({ sent });
  }

  // PATCH ?slug=xxx {active: true/false} — activate/deactivate event
  // PATCH ?slug=xxx {refunded: true/false} — mark / unmark the event as refunded (marker only: the PayPal
  //   refund itself stays manual, and the event stays active). Needs the release-two migration.
  if (req.method === "PATCH") {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: "Missing slug" });
    const body = req.body || {};

    if ("refunded" in body) {
      if (typeof body.refunded !== "boolean") return res.status(400).json({ error: "refunded must be true or false" });
      const refunded_at = body.refunded ? new Date().toISOString() : null;
      const { data: rows, error } = await supabase
        .from("events").update({ refunded_at }).eq("slug", slug).not("paid_at", "is", null).select("id");
      if (error && (error.code === "42703" || error.code === "PGRST204")) {
        return res.status(409).json({ error: "Migration needed: run sql/release-two-migration.sql first" });
      }
      if (error) return res.status(500).json({ error: error.message });
      if (!rows || rows.length === 0) return res.status(404).json({ error: "Event not found" });
      return res.status(200).json({ slug, refunded: body.refunded, refunded_at });
    }

    // Never read a missing `active` as false (that would silently deactivate the event).
    if (!("active" in body)) return res.status(400).json({ error: "Missing active or refunded" });
    const active = !!body.active;

    const { error } = await supabase.from("events").update({ active }).eq("slug", slug);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ slug, active });
  }

  // GET — list all events with RSVP counts
  if (req.method === "GET") {
    // Paid events only (hide unpaid drafts). receipt_number / refunded_at exist after the release-two
    // migration; before it Postgres answers 42703 and the old column list is used instead.
    const LIST_COLS = "id, slug, event_name, event_type, gregorian_date, event_time, location, customer_name, customer_email, dashboard_password, paid_at, active, final_responses, final_guests";
    const listEvents = (cols) => supabase
      .from("events")
      .select(`${cols}, rsvps(count)`)
      .not("paid_at", "is", null)
      .order("paid_at", { ascending: false });
    let { data: events, error } = await listEvents(`${LIST_COLS}, receipt_number, refunded_at`);
    if (error && error.code === "42703") ({ data: events, error } = await listEvents(LIST_COLS));

    if (error) return res.status(500).json({ error: error.message });

    const rows = events.map(e => ({
      ...e,
      rsvp_count: e.rsvps?.[0]?.count ?? 0,
      rsvps: undefined,
    }));

    // Confirmed checkout abandonments in the last 30 days (anonymous log, see _sweep.js)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count: abandonedLast30Days, error: abErr } = await supabase
      .from("checkout_abandonments")
      .select("*", { count: "exact", head: true })
      .gte("abandoned_at", thirtyDaysAgo);
    if (abErr) console.error("checkout_abandonments count error:", abErr.code || "", abErr.message || abErr);

    return res.status(200).json({ events: rows, abandonedLast30Days: abErr ? null : (abandonedLast30Days || 0) });
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
