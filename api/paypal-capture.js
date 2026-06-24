const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const generateReceiptPDF = require("./_receipt");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function sendEmail(to, subject, html, attachment) {
  if (!process.env.BREVO_API_KEY) return;
  const body = {
    sender: { name: "אישורי הגעה", email: "kupernetservice@gmail.com" },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };
  if (attachment) body.attachment = [attachment];
  await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(e => console.error("Brevo error:", e));
}
const PAYPAL_BASE = process.env.PAYPAL_SANDBOX === "false"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";
const BASE_URL = process.env.BASE_URL || "https://rsvp.kupernet.com";

const HE_MAP = {
  א:"a",ב:"b",ג:"g",ד:"d",ה:"h",ו:"v",ז:"z",ח:"h",ט:"t",י:"y",
  כ:"k",ך:"k",ל:"l",מ:"m",ם:"m",נ:"n",ן:"n",ס:"s",ע:"a",פ:"p",
  ף:"p",צ:"tz",ץ:"tz",ק:"k",ר:"r",ש:"sh",ת:"t",
};

function hebrewToLatin(str) {
  return str.replace(/[֑-ׇ]/g, "").split("")
    .map(c => HE_MAP[c] || (c.match(/[a-zA-Z0-9]/) ? c.toLowerCase() : ""))
    .join("").slice(0, 12);
}

const EVENT_TYPE_LABELS = {
  bar_mitzvah:"בר / בת מצווה", wedding:"חתונה", brit:"ברית מילה",
  birthday:"יום הולדת", family:"אירוע משפחתי", other:"אחר",
};

async function getAccessToken() {
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  return data.access_token;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { orderID, ...formData } = req.body || {};
  if (!orderID) return res.status(400).json({ error: "חסר מזהה הזמנה" });

  try {
    // 1. Capture PayPal payment
    const accessToken = await getAccessToken();
    const captureRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    const capture = await captureRes.json();
    if (capture.status !== "COMPLETED") {
      console.error("PayPal capture not completed:", capture);
      return res.status(400).json({ error: "התשלום לא הושלם" });
    }

    // 2. Generate slug
    const year = new Date(formData.gregorian_date + "T12:00:00").getFullYear();
    const typeMap = { bar_mitzvah:"bm", wedding:"wedding", brit:"brit", birthday:"bday", family:"family", other:"event" };
    const prefix = typeMap[formData.event_type] || "event";
    const lastName = (formData.customer_name || "").trim().split(/\s+/).pop();
    const base = `${prefix}-${hebrewToLatin(lastName) || "il"}-${year}`;
    const { data: existing } = await supabase.from("events").select("slug").eq("slug", base).maybeSingle();
    const slug = existing ? `${base}-${crypto.randomBytes(2).toString("hex")}` : base;
    const dashboard_password = crypto.randomBytes(6).toString("base64url");

    // 3. Save to Supabase
    const { error: dbErr } = await supabase.from("events").insert({
      slug,
      customer_name:  formData.customer_name?.trim(),
      customer_email: formData.customer_email?.trim(),
      customer_phone: formData.customer_phone?.trim() || null,
      event_type:     formData.event_type,
      event_name:     formData.event_name?.trim(),
      hebrew_date:    formData.hebrew_date?.trim() || null,
      gregorian_date: formData.gregorian_date,
      event_time:     formData.event_time,
      location:       formData.location?.trim(),
      address:        formData.address?.trim(),
      extra_note:     formData.extra_note?.trim() || null,
      dashboard_password,
      paid_at:        new Date().toISOString(),
    });

    if (dbErr) {
      console.error("DB error:", dbErr);
      return res.status(500).json({ error: "שגיאת מסד נתונים" });
    }

    // 4. Send confirmation + receipt emails (must complete before responding — Vercel kills the
    //    function as soon as res.json() is called, so fire-and-forget doesn't work here)
    const rsvpUrl = `${BASE_URL}/rsvp/${slug}`;
    const dashUrl = `${BASE_URL}/dashboard/${slug}`;
    const typeLabel = EVENT_TYPE_LABELS[formData.event_type] || formData.event_type;
    const email = formData.customer_email?.trim();
    const name = formData.customer_name;

    // 4a. Confirmation email
    await sendEmail(
      email,
      `אישורי הגעה ל${formData.event_name} — הפרטים שלך`,
      `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
        <h2 style="color:#1a2744">האירוע מוכן! 🎉</h2>
        <p>שלום ${name},</p>
        <p><strong>סוג אירוע:</strong> ${typeLabel}<br/>
        <strong>תאריך:</strong> ${formData.gregorian_date}<br/>
        <strong>מקום:</strong> ${formData.location}</p>
        <p><a href="${rsvpUrl}" style="background:#c9993a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-bottom:8px">🔗 קישור לאורחים</a></p>
        <p><a href="${dashUrl}" style="background:#1a2744;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">📊 דשבורד ניהול</a></p>
        <p style="background:#fdf5e0;border:2px dashed #c9993a;border-radius:8px;padding:16px;text-align:center">
          סיסמת דשבורד: <strong style="font-size:1.3rem;letter-spacing:.1em">${dashboard_password}</strong>
        </p>
      </div>`
    );

    // 4b. Receipt email with PDF attachment
    try {
      const { count } = await supabase
        .from("events").select("*", { count: "exact", head: true });
      const receiptNumber = count || 1;
      const pdfBuffer = await generateReceiptPDF({
        receiptNumber,
        customerName: name,
        paymentDate: new Date().toLocaleDateString("he-IL"),
      });
      await sendEmail(
        email,
        `קבלה מספר ${String(receiptNumber).padStart(6, "0")} — Kupernet`,
        `<div dir="rtl" style="font-family:Arial;padding:24px">
          <p>שלום ${name},</p>
          <p>מצורפת קבלה עבור תשלום אישורי הגעה לאירוע <strong>${formData.event_name}</strong>.</p>
          <p>תודה שבחרת ב-Kupernet!</p>
        </div>`,
        {
          content: pdfBuffer.toString("base64"),
          name: `קבלה-${String(receiptNumber).padStart(6, "0")}.pdf`,
        }
      );
    } catch (e) {
      console.error("Receipt email error:", e);
    }

    console.log(`✅ Event created via PayPal: ${slug}`);
    res.status(200).json({ slug, event_name: formData.event_name, dashboard_password });
  } catch (e) {
    console.error("paypal-capture error:", e);
    res.status(500).json({ error: "שגיאת שרת" });
  }
};
