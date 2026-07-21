// Creates an UNPAID event draft (paid_at = null). The event is invisible to guests
// (guest APIs filter on paid_at) until payment "publishes" it via paypal-capture.
// This lets customers build and see their event before paying — reduces the
// "pay an unknown brand upfront" barrier.
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BASE_URL = process.env.BASE_URL || "https://rsvp.kupernet.com";

async function sendEmail(to, subject, html) {
  if (!process.env.BREVO_API_KEY || !to) return;
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

const HE_MAP = {
  א:"a",ב:"b",ג:"g",ד:"d",ה:"h",ו:"v",ז:"z",ח:"h",ט:"t",י:"y",
  כ:"k",ך:"k",ל:"l",מ:"m",ם:"m",נ:"n",ן:"n",ס:"s",ע:"a",פ:"p",
  ף:"p",צ:"tz",ץ:"tz",ק:"k",ר:"r",ש:"sh",ת:"t",
};
function hebrewToLatin(str) {
  return String(str || "").replace(/[֑-ׇ]/g, "").split("")
    .map(c => HE_MAP[c] || (c.match(/[a-zA-Z0-9]/) ? c.toLowerCase() : ""))
    .join("").slice(0, 12);
}

function validate(b) {
  const required = ["event_type","event_name","gregorian_date","event_time","location","address","customer_name","customer_email"];
  for (const f of required) if (!b[f] || !String(b[f]).trim()) return `שדה חסר: ${f}`;
  if (!/^\S+@\S+\.\S+$/.test(b.customer_email)) return "אימייל לא תקין";
  if (b.gregorian_date < new Date().toISOString().slice(0, 10)) return "לא ניתן לבחור תאריך שעבר";
  return null;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const b = req.body || {};
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });

  try {
    const year = new Date(b.gregorian_date + "T12:00:00").getFullYear();
    const typeMap = { bar_mitzvah:"bm", bat_mitzvah:"btm", wedding:"wedding", brit:"brit", brit_bat:"britb", birthday:"bday", bachelor:"bach", bachelorette:"bachette", henna:"henna", family:"family", other:"event" };
    const prefix = typeMap[b.event_type] || "event";
    const lastName = (b.customer_name || "").trim().split(/\s+/).pop();
    const base = `${prefix}-${hebrewToLatin(lastName) || "il"}-${year}`;
    const { data: existing } = await supabase.from("events").select("slug").eq("slug", base).maybeSingle();
    const slug = existing ? `${base}-${crypto.randomBytes(2).toString("hex")}` : base;
    const dashboard_password = crypto.randomBytes(6).toString("base64url");

    const { error: dbErr } = await supabase.from("events").insert({
      slug,
      customer_name:  b.customer_name?.trim(),
      customer_email: b.customer_email?.trim(),
      customer_phone: b.customer_phone?.trim() || null,
      event_type:     b.event_type,
      event_name:     b.event_name?.trim(),
      hebrew_date:    b.hebrew_date?.trim() || null,
      gregorian_date: b.gregorian_date,
      event_time:     b.event_time,
      location:       b.location?.trim(),
      address:        b.address?.trim(),
      extra_note:     b.extra_note?.trim() || null,
      dashboard_password,
      paid_at:        null,   // draft — not published until paid
      active:         true,
    });
    if (dbErr) { console.error("create-event DB error:", dbErr); return res.status(500).json({ error: "שגיאת מסד נתונים" }); }

    // Email the organizer their dashboard link + password so they can return and publish anytime
    const dashUrl = `${BASE_URL}/dashboard/${slug}`;
    sendEmail(
      b.customer_email?.trim(),
      `הטיוטה שלך נשמרה — ${b.event_name}`,
      `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
        <h2 style="color:#1a2744">האירוע שלך נשמר 📝</h2>
        <p>שלום ${b.customer_name || ""},</p>
        <p>שמרנו את פרטי האירוע שלך. הוא עדיין לא פורסם — כדי לקבל קישור לשליחה לאורחים, יש להשלים תשלום חד-פעמי של ₪99.</p>
        <p><a href="${dashUrl}" style="background:#1a2744;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">📊 כניסה וניהול / פרסום</a></p>
        <p style="background:#fdf5e0;border:2px dashed #c9993a;border-radius:8px;padding:16px;text-align:center">
          סיסמת ניהול: <strong style="font-size:1.3rem;letter-spacing:.1em">${dashboard_password}</strong>
        </p>
        <p style="font-size:.85rem;color:#6b7280">אפשר לחזור ולפרסם בכל עת דרך הקישור הזה.</p>
      </div>`
    );

    return res.status(200).json({ slug, dashboard_password });
  } catch (e) {
    console.error("create-event error:", e);
    return res.status(500).json({ error: "שגיאת שרת" });
  }
};
