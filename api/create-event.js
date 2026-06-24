const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE_URL = process.env.BASE_URL || "https://rsvp.kupernet.com";

async function sendEmail(to, subject, html) {
  if (!process.env.BREVO_API_KEY) return;
  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender: { name: "אישורי הגעה", email: "kupernetservice@gmail.com" },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  }).catch(e => console.error("Brevo error:", e));
}

// Hebrew → Latin transliteration for slug
const HE_MAP = {
  א:"a",ב:"b",ג:"g",ד:"d",ה:"h",ו:"v",ז:"z",ח:"h",ט:"t",י:"y",
  כ:"k",ך:"k",ל:"l",מ:"m",ם:"m",נ:"n",ן:"n",ס:"s",ע:"a",פ:"p",
  ף:"p",צ:"tz",ץ:"tz",ק:"k",ר:"r",ש:"sh",ת:"t"
};

function hebrewToLatin(str) {
  return str
    .replace(/[֑-ׇ]/g, "")
    .split("")
    .map(c => HE_MAP[c] || (c.match(/[a-zA-Z0-9]/) ? c.toLowerCase() : ""))
    .join("")
    .slice(0, 12);
}

function generatePassword() {
  return crypto.randomBytes(6).toString("base64url");
}

async function generateSlug(eventType, customerName, year) {
  const typeMap = {
    bar_mitzvah:"bm", bat_mitzvah:"btm", wedding:"wedding", brit:"brit",
    brit_bat:"britb", birthday:"bday", family:"family", other:"event"
  };
  const prefix   = typeMap[eventType] || "event";
  const lastName = customerName.trim().split(/\s+/).pop();
  const base     = `${prefix}-${hebrewToLatin(lastName) || "il"}-${year}`;

  const { data } = await supabase.from("events").select("slug").eq("slug", base).maybeSingle();
  if (!data) return base;
  return `${base}-${crypto.randomBytes(2).toString("hex")}`;
}

function validate(body) {
  const required = ["event_type","event_name","gregorian_date","event_time",
                    "location","address","customer_name","customer_email"];
  for (const f of required) {
    if (!body[f] || !String(body[f]).trim()) return `שדה חסר: ${f}`;
  }
  if (!/^\S+@\S+\.\S+$/.test(body.customer_email)) return "אימייל לא תקין";
  return null;
}

const EVENT_TYPE_LABELS = {
  bar_mitzvah:"בר מצווה", bat_mitzvah:"בת מצווה", wedding:"חתונה",
  brit:"ברית מילה", brit_bat:"בריתה",
  birthday:"יום הולדת", family:"אירוע משפחתי", other:"אחר"
};

function buildEmail(meta, slug, dashboard_password) {
  const rsvpUrl  = `${BASE_URL}/rsvp/${slug}`;
  const dashUrl  = `${BASE_URL}/dashboard/${slug}`;
  const typeLabel = EVENT_TYPE_LABELS[meta.event_type] || meta.event_type;

  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="UTF-8"/>
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
    <div class="info-row"><div class="lbl">סוג אירוע</div><div class="val">${typeLabel}</div></div>
    <div class="info-row">
      <div class="lbl">תאריך</div>
      <div class="val">${meta.hebrew_date ? meta.hebrew_date + " · " : ""}${meta.gregorian_date}</div>
    </div>
    <div class="info-row"><div class="lbl">שעה</div><div class="val">${meta.event_time}</div></div>
    <div class="info-row">
      <div class="lbl">מיקום</div><div class="val">${meta.location}</div>
      <div class="sub">${meta.address}</div>
    </div>
    ${meta.extra_note ? `<div class="info-row"><div class="lbl">הערה</div><div class="val" style="font-size:.9rem">${meta.extra_note}</div></div>` : ""}

    <div class="cta-block">
      <p>הקישורים שלך:</p>
      <a class="btn btn-gold" href="${rsvpUrl}">🔗 קישור לאורחים (לשתף בוואטסאפ)</a>
      <a class="btn btn-navy" href="${dashUrl}">📊 דשבורד ניהול</a>
    </div>

    <div class="pw-box">
      <div class="pw-lbl">סיסמת הדשבורד שלך</div>
      <div class="pw-val">${dashboard_password}</div>
      <div class="pw-note">שמור את הסיסמה — היא לא תישלח שוב</div>
    </div>

    <p class="note">שלח את קישור האורחים בוואטסאפ או בהזמנה הדיגיטלית.
    בדשבורד תוכל לעקוב אחר האישורים בזמן אמת.</p>
  </div>
  <div class="footer">מערכת אישורי הגעה · rsvp.kupernet.com</div>
</div>
</body></html>`;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const err  = validate(body);
  if (err) return res.status(400).json({ error: err });

  try {
    const year               = new Date(body.gregorian_date + "T12:00:00").getFullYear();
    const slug               = await generateSlug(body.event_type, body.customer_name, year);
    const dashboard_password = generatePassword();

    // Save to Supabase
    const { error: dbErr } = await supabase.from("events").insert({
      slug,
      customer_name:      body.customer_name.trim(),
      customer_email:     body.customer_email.trim(),
      customer_phone:     body.customer_phone?.trim() || null,
      event_type:         body.event_type,
      event_name:         body.event_name.trim(),
      hebrew_date:        body.hebrew_date?.trim()   || null,
      gregorian_date:     body.gregorian_date,
      event_time:         body.event_time,
      location:           body.location.trim(),
      address:            body.address.trim(),
      extra_note:         body.extra_note?.trim()    || null,
      dashboard_password,
      paid_at:            new Date().toISOString(),  // free during beta
    });

    if (dbErr) {
      console.error("DB error:", dbErr);
      return res.status(500).json({ error: "שגיאת מסד נתונים", dbErr });
    }

    // Send email (non-blocking — don't fail if email fails)
    sendEmail(
      body.customer_email.trim(),
      `אישורי הגעה ל${body.event_name} — הפרטים שלך`,
      buildEmail(body, slug, dashboard_password)
    );

    console.log(`✅ Event created: ${slug} for ${body.customer_email}`);
    res.status(200).json({ slug, event_name: body.event_name, dashboard_password });

  } catch (e) {
    console.error("create-event error:", e);
    res.status(500).json({ error: "שגיאת שרת" });
  }
};
