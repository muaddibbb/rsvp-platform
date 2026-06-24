const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

const BASE_URL = "https://rsvp.kupernet.com";

// Read raw body (required for Stripe signature verification)
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const EVENT_TYPE_LABELS = {
  bar_mitzvah: "בר מצווה",
  bat_mitzvah: "בת מצווה",
  wedding:     "חתונה",
  brit:        "ברית מילה",
  brit_bat:    "בריתה",
  birthday:    "יום הולדת",
  family:      "אירוע משפחתי",
  other:       "אירוע",
};

function buildEmail(meta) {
  const rsvpUrl      = `${BASE_URL}/rsvp/${meta.slug}`;
  const dashUrl      = `${BASE_URL}/dashboard/${meta.slug}`;
  const eventLabel   = EVENT_TYPE_LABELS[meta.event_type] || "אירוע";

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="UTF-8"/>
<style>
  body{font-family:Arial,sans-serif;background:#f4f1eb;direction:rtl;margin:0;padding:20px}
  .wrap{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .hdr{background:linear-gradient(150deg,#1a2744,#243360);color:#fff;padding:40px 32px;text-align:center}
  .hdr .star{font-size:40px;color:#f0d080}
  .hdr h1{color:#f0d080;font-size:1.5rem;margin:12px 0 4px}
  .hdr p{opacity:.8;margin:0;font-size:.95rem}
  .body{padding:32px}
  .info-row{padding:12px 0;border-bottom:1px solid #f0ece4}
  .info-row:last-child{border-bottom:none}
  .lbl{font-size:.75rem;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
  .val{font-size:1rem;font-weight:600;color:#1a1a2e;margin-top:2px}
  .sub{font-size:.88rem;color:#6b7280}
  .cta-block{background:#f4f1eb;border-radius:12px;padding:20px;margin:24px 0}
  .cta-block p{font-weight:700;color:#1a2744;margin:0 0 14px}
  .btn{display:block;text-align:center;padding:14px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;margin-bottom:10px}
  .btn-gold{background:linear-gradient(135deg,#c9993a,#b8841e);color:#fff}
  .btn-navy{background:#1a2744;color:#fff}
  .pw-box{background:#fdf5e0;border:2px dashed #c9993a;border-radius:10px;padding:16px;text-align:center;margin:16px 0}
  .pw-lbl{font-size:.85rem;color:#6b7280;margin-bottom:4px}
  .pw-val{font-size:1.5rem;font-weight:800;color:#1a2744;letter-spacing:.12em;font-family:monospace}
  .pw-note{font-size:.78rem;color:#9ca3af;margin-top:8px}
  .note{color:#6b7280;font-size:.88rem;line-height:1.6}
  .footer{text-align:center;padding:20px;color:#9ca3af;font-size:.78rem}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div class="star">✡</div>
    <h1>${meta.event_name}</h1>
    <p>שלום ${meta.customer_name}, אישורי ההגעה שלך מוכנים!</p>
  </div>
  <div class="body">
    <div class="info-row">
      <div class="lbl">סוג אירוע</div>
      <div class="val">${eventLabel}</div>
    </div>
    <div class="info-row">
      <div class="lbl">תאריך</div>
      <div class="val">${meta.hebrew_date ? meta.hebrew_date + " · " : ""}${meta.gregorian_date}</div>
    </div>
    <div class="info-row">
      <div class="lbl">שעה</div>
      <div class="val">${meta.event_time}</div>
    </div>
    <div class="info-row">
      <div class="lbl">מיקום</div>
      <div class="val">${meta.location}</div>
      <div class="sub">${meta.address}</div>
    </div>
    ${meta.extra_note ? `<div class="info-row"><div class="lbl">הערה</div><div class="val" style="font-size:.95rem">${meta.extra_note}</div></div>` : ""}

    <div class="cta-block">
      <p>הקישורים שלך:</p>
      <a class="btn btn-gold" href="${rsvpUrl}">🔗 קישור לאורחים (לשתף בוואטסאפ)</a>
      <a class="btn btn-navy" href="${dashUrl}">📊 דשבורד ניהול</a>
    </div>

    <div class="pw-box">
      <div class="pw-lbl">סיסמת הדשבורד שלך</div>
      <div class="pw-val">${meta.dashboard_password}</div>
      <div class="pw-note">שמור את הסיסמה הזו — היא לא תישלח שוב</div>
    </div>

    <p class="note">
      שלח את קישור האורחים בוואטסאפ, בהזמנה הדיגיטלית, או בכל דרך שתבחר.
      בדשבורד תוכל לעקוב אחר האישורים בזמן אמת ולנהל את רשימת האורחים.
    </p>
  </div>
  <div class="footer">נשלח על ידי מערכת אישורי הגעה · rsvp.kupernet.com</div>
</div>
</body>
</html>`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  const sig     = req.headers["stripe-signature"];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).json({ error: "Bad signature" });
  }

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const meta    = session.metadata;

  try {
    // Save event to Supabase
    const { error: dbErr } = await supabase.from("events").insert({
      slug:               meta.slug,
      customer_name:      meta.customer_name,
      customer_email:     meta.customer_email,
      customer_phone:     meta.customer_phone || null,
      event_type:         meta.event_type,
      event_name:         meta.event_name,
      hebrew_date:        meta.hebrew_date   || null,
      gregorian_date:     meta.gregorian_date,
      event_time:         meta.event_time,
      location:           meta.location,
      address:            meta.address,
      extra_note:         meta.extra_note    || null,
      dashboard_password: meta.dashboard_password,
      stripe_session_id:  session.id,
      paid_at:            new Date().toISOString(),
    });

    if (dbErr) {
      console.error("Supabase insert error:", dbErr);
      return res.status(500).json({ error: "DB error" });
    }

    // Send confirmation email
    await resend.emails.send({
      from:    "אישורי הגעה <rsvp@kupernet.com>",
      to:      meta.customer_email,
      subject: `אישורי הגעה ל${meta.event_name} — הפרטים שלך`,
      html:    buildEmail(meta),
    });

    console.log(`✅ Event created: ${meta.slug} for ${meta.customer_email}`);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
