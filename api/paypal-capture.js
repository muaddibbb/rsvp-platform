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
  bar_mitzvah:"בר מצווה", bat_mitzvah:"בת מצווה", wedding:"חתונה",
  brit:"ברית מילה", brit_bat:"בריתה", birthday:"יום הולדת",
  bachelor:"מסיבת רווקים", bachelorette:"מסיבת רווקות",
  henna:"חינה", family:"אירוע משפחתי", other:"אחר",
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

  // Record a pending checkout: fired when the user reaches step 3 (all fields filled)
  // but before payment completes. A sweep in cleanup.js later emails about ones never paid.
  if (req.query.pending) {
    const p = req.body || {};
    if (!p.checkoutId) return res.status(400).json({ error: "missing checkoutId" });
    const { error: pErr } = await supabase.from("pending_checkouts").upsert({
      id:             String(p.checkoutId),
      customer_name:  p.customer_name?.trim()  || null,
      customer_email: p.customer_email?.trim() || null,
      customer_phone: p.customer_phone?.trim() || null,
      event_type:     p.event_type             || null,
      event_name:     p.event_name?.trim()     || null,
      gregorian_date: p.gregorian_date          || null,
      event_time:     p.event_time              || null,
      location:       p.location?.trim()        || null,
      updated_at:     new Date().toISOString(),
      notified:       false,
    }, { onConflict: "id" });
    if (pErr) {
      console.error("pending upsert error:", pErr);
      return res.status(500).json({ ok: false, error: pErr.message });
    }
    return res.status(200).json({ ok: true });
  }

  const { orderID, checkoutId, slug: publishSlug, ...formData } = req.body || {};
  if (!orderID) return res.status(400).json({ error: "חסר מזהה הזמנה" });
  const today = new Date().toISOString().slice(0, 10);
  if (formData.gregorian_date && formData.gregorian_date < today)
    return res.status(400).json({ error: "לא ניתן לבחור תאריך שעבר" });

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

      // Extract a human-readable decline/failure reason from PayPal's response
      const cap    = capture?.purchase_units?.[0]?.payments?.captures?.[0];
      const detail = capture?.details?.[0] || {};
      const issue  = detail.issue || cap?.status_details?.reason || cap?.status || capture?.name || capture?.status || "UNKNOWN";
      const desc   = detail.description || capture?.message || "";

      // Alert the owner about the failed payment attempt (await — Vercel kills the fn after the response)
      const typeLabel = EVENT_TYPE_LABELS[formData.event_type] || formData.event_type || "—";
      await sendEmail(
        "kuperoy@gmail.com",
        `⚠️ תשלום נכשל: ${formData.event_name || "ללא שם"}`,
        `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
          <h2 style="color:#991b1b">ניסיון תשלום נכשל ⚠️</h2>
          <p><strong>סיבה (PayPal):</strong> ${issue}${desc ? `<br/><span style="color:#6b7280">${desc}</span>` : ""}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:14px 0"/>
          <p><strong>אירוע:</strong> ${formData.event_name || "—"} (${typeLabel})<br/>
          <strong>תאריך האירוע:</strong> ${formData.gregorian_date || "—"}<br/>
          <strong>לקוח:</strong> ${formData.customer_name || "—"}<br/>
          <strong>אימייל:</strong> ${formData.customer_email || "—"}<br/>
          <strong>טלפון:</strong> ${formData.customer_phone || "—"}<br/>
          <strong>מזהה הזמנה:</strong> ${orderID}<br/>
          <strong>מזהה תקלה (debug_id):</strong> ${capture?.debug_id || "—"}</p>
          <p style="color:#6b7280;font-size:.9rem">כדאי ליצור קשר עם הלקוח ולעזור לו להשלים את התשלום.</p>
        </div>`
      );

      return res.status(400).json({ error: "התשלום לא הושלם" });
    }

    // 2. Publish an existing draft (create-then-pay), or legacy create-on-capture.
    const EDITABLE = ["customer_name","customer_email","customer_phone","event_type","event_name","hebrew_date","gregorian_date","event_time","location","address","extra_note"];
    let slug, dashboard_password;

    if (publishSlug) {
      // Publish: find the unpaid draft, apply any last-minute edits, mark it paid (live).
      const { data: ev, error: exErr } = await supabase
        .from("events").select("*").eq("slug", publishSlug).maybeSingle();
      if (exErr || !ev) {
        console.error("publish: draft not found", publishSlug, exErr);
        return res.status(404).json({ error: "האירוע לא נמצא" });
      }
      slug = ev.slug;
      dashboard_password = ev.dashboard_password;

      const upd = { paid_at: new Date().toISOString() };
      for (const f of EDITABLE) {
        if (formData[f] !== undefined && formData[f] !== null && String(formData[f]).trim() !== "") {
          upd[f] = String(formData[f]).trim();
        }
      }
      const { error: uErr } = await supabase.from("events").update(upd).eq("id", ev.id);
      if (uErr) { console.error("publish update error:", uErr); return res.status(500).json({ error: "שגיאת מסד נתונים" }); }

      // Backfill formData from the draft for the emails below (in case client omitted fields)
      for (const f of EDITABLE) if (formData[f] === undefined || formData[f] === null || formData[f] === "") formData[f] = ev[f];
    } else {
      // Legacy path: generate slug + insert a fresh paid event.
      const year = new Date(formData.gregorian_date + "T12:00:00").getFullYear();
      const typeMap = { bar_mitzvah:"bm", bat_mitzvah:"btm", wedding:"wedding", brit:"brit", brit_bat:"britb", birthday:"bday", bachelor:"bach", bachelorette:"bachette", henna:"henna", family:"family", other:"event" };
      const prefix = typeMap[formData.event_type] || "event";
      const lastName = (formData.customer_name || "").trim().split(/\s+/).pop();
      const base = `${prefix}-${hebrewToLatin(lastName) || "il"}-${year}`;
      const { data: existing } = await supabase.from("events").select("slug").eq("slug", base).maybeSingle();
      slug = existing ? `${base}-${crypto.randomBytes(2).toString("hex")}` : base;
      dashboard_password = crypto.randomBytes(6).toString("base64url");

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
    }

    // Payment completed — remove the pending-checkout record so no abandonment email fires
    if (checkoutId) {
      await supabase.from("pending_checkouts").delete().eq("id", String(checkoutId));
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
        <p><a href="${dashUrl}" style="background:#1a2744;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">📊 ממשק ניהול הזמנה</a></p>
        <p style="background:#fdf5e0;border:2px dashed #c9993a;border-radius:8px;padding:16px;text-align:center">
          סיסמת ממשק ניהול הזמנה: <strong style="font-size:1.3rem;letter-spacing:.1em">${dashboard_password}</strong>
        </p>
        <p style="font-size:.82rem;color:#6b7280;background:#f3f4f6;border-radius:8px;padding:10px 14px;margin-top:16px;line-height:1.6">
          🗓️ תזכורת: האירוע ונתוני האורחים יימחקו אוטומטית חודש אחד לאחר תאריך האירוע (${formData.gregorian_date}).
        </p>
      </div>`
    );

    // 4b. Receipt email with PDF attachment
    try {
      const { count } = await supabase
        .from("events").select("*", { count: "exact", head: true })
        .not("paid_at", "is", null);   // count only paid events, not unpaid drafts
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

    // 4c. Admin notification
    try {
      await sendEmail(
        "kuperoy@gmail.com",
        `💰 הזמנה חדשה: ${formData.event_name} (₪99)`,
        `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
          <h2 style="color:#1a2744">הזמנה חדשה התקבלה 💰</h2>
          <p><strong>אירוע:</strong> ${formData.event_name} (${typeLabel})<br/>
          <strong>תאריך האירוע:</strong> ${formData.gregorian_date}<br/>
          <strong>לקוח:</strong> ${name}<br/>
          <strong>אימייל:</strong> ${email}<br/>
          <strong>טלפון:</strong> ${formData.customer_phone || "—"}<br/>
          <strong>Slug:</strong> ${slug}</p>
          <p><a href="${BASE_URL}/admin">פתח את פאנל הניהול</a></p>
        </div>`
      );
    } catch (e) {
      console.error("Admin notification error:", e);
    }

    console.log(`✅ Event created via PayPal: ${slug}`);
    res.status(200).json({ slug, event_name: formData.event_name, dashboard_password });
  } catch (e) {
    console.error("paypal-capture error:", e);
    res.status(500).json({ error: "שגיאת שרת" });
  }
};
