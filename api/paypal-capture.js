const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const generateReceiptPDF = require("./_receipt");
const { buildReceipt, receiptNumberFor } = generateReceiptPDF;
const { esc, oneLine } = require("./_mail");
const { clientIp, originVerdict, overLimit, HOUR, DAY } = require("./_ratelimit");
const { PRICE_ILS, CURRENCY, parseCustomId, paypalBase } = require("./_pay");

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
const PAYPAL_BASE = paypalBase();
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

// Owner alert e-mail (kuperoy@gmail.com). `html` must already be escaped by the caller.
async function alertOwner(subject, html) {
  try {
    await sendEmail("kuperoy@gmail.com", subject,
      `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">${html}</div>`);
  } catch (e) { console.error("owner alert error:", e); }
}

// J-02: is this PayPal order one our server created, for exactly the price, still waiting for capture?
// -> { ok: true, slug } (slug null = legacy "new" order) or { ok: false, reason }.
// `completed: true` marks an order that OUR server signed and that is already paid (a retry after the
// capture happened): the caller answers it differently from "nothing was captured".
function checkOrder(order) {
  if (!order || typeof order !== "object") return { ok: false, reason: "order not readable" };
  const units = order.purchase_units;
  if (order.status === "COMPLETED" && Array.isArray(units) && units.length === 1
      && units[0] && parseCustomId(units[0].custom_id).valid) {
    return { ok: false, completed: true, reason: "order already completed" };
  }
  if (order.status !== "APPROVED") return { ok: false, reason: "order status " + order.status };
  if (!Array.isArray(units) || units.length !== 1) return { ok: false, reason: "purchase units" };
  // Defence in depth: refuse a wrong intent, and a wrong payee when PayPal returns one. An absent field is
  // accepted (real orders must never be refused for it). The payee is compared to PAYPAL_MERCHANT_ID,
  // an optional env var (unset = no payee check).
  if (order.intent !== undefined && order.intent !== "CAPTURE") return { ok: false, reason: "intent " + order.intent };
  const payee = units[0].payee && units[0].payee.merchant_id;
  const merchant = process.env.PAYPAL_MERCHANT_ID;
  if (merchant && payee && payee !== merchant) return { ok: false, reason: "payee " + payee };
  const amt = units[0].amount || {};
  if (amt.currency_code !== CURRENCY) return { ok: false, reason: "currency " + amt.currency_code };
  if (Number(amt.value) !== PRICE_ILS) return { ok: false, reason: "amount " + amt.value };
  const sig = parseCustomId(units[0].custom_id);
  if (!sig.valid) return { ok: false, reason: "order was not created by this server" };
  return { ok: true, slug: sig.slug };
}

// Answer after the money moved but the event was not stored/published (never 400: clients read 400 as
// "nothing captured"). The clients show their own "unknown, contact us" text with the order id.
const POST_CAPTURE_ERROR = "התשלום התקבל אך הפרסום נכשל. אנא צרו קשר";
// The capture request itself failed without a readable answer: we do not know whether money moved.
const CAPTURE_UNKNOWN_ERROR = "לא ניתן לאמת אם התשלום התקבל. אנא צרו קשר";

// M-2: the money was taken but the event could not be published / stored. Tell the owner (escaped values).
async function alertUnpublished(orderID, slug, why) {
  await alertOwner(
    "⚠️ תשלום נתקבל ולא פורסם — נדרשת בדיקה",
    `<p>PayPal גבה תשלום אך ייתכן שהאירוע לא נשמר או לא פורסם. יש ליצור קשר עם הקונה או לזכות ב-PayPal.</p>
     <p><strong>מזהה הזמנה:</strong> ${esc(orderID)}<br/>
     <strong>Slug:</strong> ${esc(slug || "—")}<br/>
     <strong>סיבה:</strong> ${esc(why)}</p>`
  );
}

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
  if (originVerdict(req) === "mismatch") return res.status(403).json({ error: "Forbidden" });

  if (req.query.pending) {
    const p = req.body || {};
    // J-04: a plain id token, text fields capped at 200 chars, and per-IP / per-e-mail limits (the
    // recovery e-mail goes to this address later, so one victim cannot be queued more than 3 times a day).
    if (typeof p.checkoutId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(p.checkoutId)) {
      return res.status(400).json({ error: "missing checkoutId" });
    }
    const cap200 = (v) => (v == null ? null : String(v).trim().slice(0, 200) || null);
    const pendingEmail = cap200(p.customer_email);
    const rules = [["pend-ip", clientIp(req), HOUR, 30]];
    if (pendingEmail) rules.push(["pend-mail", pendingEmail.toLowerCase(), DAY, 3]);
    if (await overLimit(supabase, req, rules)) {
      res.setHeader("Retry-After", String(HOUR));
      return res.status(429).json({ ok: false, error: "too many requests" });
    }
    const { error: pErr } = await supabase.from("pending_checkouts").upsert({
      id:             p.checkoutId,
      customer_name:  cap200(p.customer_name),
      customer_email: pendingEmail,
      customer_phone: cap200(p.customer_phone),
      event_type:     cap200(p.event_type),
      event_name:     cap200(p.event_name),
      gregorian_date: cap200(p.gregorian_date),
      event_time:     cap200(p.event_time),
      location:       cap200(p.location),
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
  // J-05: the id is put into a PayPal URL, so only a plain token is accepted, before any PayPal call.
  if (typeof orderID !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(orderID)) {
    return res.status(400).json({ error: "מזהה הזמנה לא תקין" });
  }
  // J-04: capture is rate limited per IP; answers 400 (nothing captured) so the pay page re-enables its button.
  if (await overLimit(supabase, req, [["cap-ip", clientIp(req), HOUR, 20]])) {
    return res.status(400).json({ error: "יותר מדי ניסיונות, נסו שוב מאוחר יותר" });
  }
  const today = new Date().toISOString().slice(0, 10);
  if (formData.gregorian_date && formData.gregorian_date < today)
    return res.status(400).json({ error: "לא ניתן לבחור תאריך שעבר" });

  let captured = false;   // true once PayPal confirmed the money moved: from then on no failure may be silent
  let captureAttempted = false;   // true while the capture request is in flight / its answer is unread
  let signedSlugForAlert = null;
  try {
    const accessToken = await getAccessToken();
    const orderUrl = `${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}`;
    const authHeader = { Authorization: `Bearer ${accessToken}` };

    // 1. Read the order back from PayPal and check it BEFORE any money moves (J-02, J-03).
    //    Every refusal here answers 400: nothing was captured.
    const orderRes = await fetch(orderUrl, { headers: authHeader });
    const order = orderRes.ok ? await orderRes.json().catch(() => null) : null;
    const verdict = checkOrder(order);
    if (verdict.completed) {
      // Money already moved on an earlier request. NOT 400 (the clients would re-enable the button and
      // allow a second payment): 409 keeps them locked on "unknown, contact us" with the order id.
      console.error("capture retry of an already completed order:", orderID);
      return res.status(409).json({ error: "ההזמנה כבר שולמה והתשלום התקבל. נחזור אליכם בהקדם" });
    }
    if (!verdict.ok) {
      console.error("capture refused before capture:", verdict.reason);
      return res.status(400).json({ error: "ההזמנה לא תקינה, התשלום לא בוצע" });
    }
    // The mode comes from the signed order, not from the request body: a signed slug S publishes S.
    // A signed "new" order is the legacy create path (a slug in the body is ignored, as before).
    const signedSlug = verdict.slug;
    signedSlugForAlert = signedSlug;
    if (signedSlug && publishSlug && publishSlug !== signedSlug) {
      console.error("capture refused: body slug differs from the signed slug");
      return res.status(400).json({ error: "ההזמנה לא תואמת לאירוע, התשלום לא בוצע" });
    }
    let draft = null;
    if (signedSlug) {
      const { data: ev, error: exErr } = await supabase
        .from("events").select("*").eq("slug", signedSlug).maybeSingle();
      if (exErr) { console.error("publish: draft lookup error", exErr); return res.status(500).json({ error: "שגיאת מסד נתונים" }); }
      if (!ev) return res.status(400).json({ error: "האירוע לא נמצא, התשלום לא בוצע" });
      if (ev.paid_at) return res.status(400).json({ error: "האירוע כבר פורסם" });
      draft = ev;
    }

    // 2. Capture PayPal payment
    captureAttempted = true;
    const captureRes = await fetch(`${orderUrl}/capture`, {
      method: "POST",
      headers: { ...authHeader, "Content-Type": "application/json" },
    });
    const capture = await captureRes.json();
    captureAttempted = false;   // PayPal's answer was read: the outcome is known from here
    if (capture.status !== "COMPLETED") {
      console.error("PayPal capture not completed:", capture);

      // Extract a human-readable decline/failure reason from PayPal's response
      const cap    = capture?.purchase_units?.[0]?.payments?.captures?.[0];
      const detail = capture?.details?.[0] || {};
      const issue  = detail.issue || cap?.status_details?.reason || cap?.status || capture?.name || capture?.status || "UNKNOWN";
      const desc   = detail.description || capture?.message || "";

      // Alert the owner about the failed payment attempt (await — Vercel kills the fn after the response).
      // Every caller-controlled value is escaped (J-04).
      const typeLabel = EVENT_TYPE_LABELS[formData.event_type] || formData.event_type || "—";
      await sendEmail(
        "kuperoy@gmail.com",
        `⚠️ תשלום נכשל: ${oneLine(formData.event_name) || "ללא שם"}`,
        `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
          <h2 style="color:#991b1b">ניסיון תשלום נכשל ⚠️</h2>
          <p><strong>סיבה (PayPal):</strong> ${esc(issue)}${desc ? `<br/><span style="color:#6b7280">${esc(desc)}</span>` : ""}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:14px 0"/>
          <p><strong>אירוע:</strong> ${esc(formData.event_name || "—")} (${esc(typeLabel)})<br/>
          <strong>תאריך האירוע:</strong> ${esc(formData.gregorian_date || "—")}<br/>
          <strong>לקוח:</strong> ${esc(formData.customer_name || "—")}<br/>
          <strong>אימייל:</strong> ${esc(formData.customer_email || "—")}<br/>
          <strong>טלפון:</strong> ${esc(formData.customer_phone || "—")}<br/>
          <strong>מזהה הזמנה:</strong> ${esc(orderID)}<br/>
          <strong>מזהה תקלה (debug_id):</strong> ${esc(capture?.debug_id || "—")}</p>
          <p style="color:#6b7280;font-size:.9rem">כדאי ליצור קשר עם הלקוח ולעזור לו להשלים את התשלום.</p>
        </div>`
      );

      return res.status(400).json({ error: "התשלום לא הושלם" });
    }

    // 3. The money may have moved. Verify what was really captured. A mismatch cannot be undone here:
    //    do not publish, tell the owner, and answer 502 (NOT 400: the clients map that to "unknown, contact us").
    const cap = capture?.purchase_units?.[0]?.payments?.captures?.[0];
    const capOk = cap && cap.status === "COMPLETED"
      && cap.amount && cap.amount.currency_code === CURRENCY && Number(cap.amount.value) === PRICE_ILS;
    if (!capOk) {
      console.error("capture verification failed after capture:", JSON.stringify(cap || null));
      await alertOwner(
        "⚠️ תשלום שנגבה לא תואם — נדרשת בדיקה",
        `<p>PayPal גבה תשלום שאינו תואם את המחיר, האירוע <strong>לא</strong> פורסם.</p>
         <p><strong>מזהה הזמנה:</strong> ${esc(orderID)}<br/>
         <strong>סטטוס:</strong> ${esc(cap?.status || "—")}<br/>
         <strong>סכום:</strong> ${esc(cap?.amount?.value || "—")} ${esc(cap?.amount?.currency_code || "")}<br/>
         <strong>Slug:</strong> ${esc(signedSlug || "—")}</p>`
      );
      return res.status(502).json({ error: "התשלום התקבל אך לא ניתן לאמת אותו. אנא צרו קשר" });
    }

    captured = true;

    // 4. Publish an existing draft (create-then-pay), or legacy create-on-capture.
    const EDITABLE = ["customer_name","customer_email","customer_phone","event_type","event_name","hebrew_date","gregorian_date","event_time","location","address","extra_note"];
    let slug, dashboard_password, paidAt;

    if (draft) {
      // Publish: apply any last-minute edits, mark it paid (live). The `paid_at is null` guard makes a
      // double payment race lose cleanly instead of overwriting.
      slug = draft.slug;
      dashboard_password = draft.dashboard_password;

      paidAt = new Date().toISOString();
      const upd = { paid_at: paidAt };
      for (const f of EDITABLE) {
        if (formData[f] !== undefined && formData[f] !== null && String(formData[f]).trim() !== "") {
          upd[f] = String(formData[f]).trim();
        }
      }
      const { data: updated, error: uErr } = await supabase
        .from("events").update(upd).eq("id", draft.id).is("paid_at", null).select("id");
      if (uErr) {
        console.error("publish update error:", uErr);
        await alertUnpublished(orderID, signedSlug, "publish update failed: " + (uErr.message || "error"));
        return res.status(502).json({ error: POST_CAPTURE_ERROR });
      }
      if (!updated || updated.length === 0) {
        await alertOwner(
          "⚠️ תשלום כפול — נדרש זיכוי",
          `<p>התקבל תשלום עבור אירוע שכבר פורסם. נדרש זיכוי ידני ב-PayPal.</p>
           <p><strong>מזהה הזמנה לזיכוי:</strong> ${esc(orderID)}<br/><strong>Slug:</strong> ${esc(signedSlug)}</p>`
        );
        return res.status(409).json({ error: "האירוע כבר פורסם. התשלום יוחזר, אנא צרו קשר" });
      }

      // Backfill formData from the draft for the emails below (in case client omitted fields)
      for (const f of EDITABLE) if (formData[f] === undefined || formData[f] === null || formData[f] === "") formData[f] = draft[f];
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
      paidAt = new Date().toISOString();

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
        paid_at:        paidAt,
      });
      if (dbErr) {
        console.error("DB error:", dbErr);
        await alertUnpublished(orderID, slug, "event insert failed: " + (dbErr.message || "error"));
        return res.status(502).json({ error: POST_CAPTURE_ERROR });
      }
    }

    // Receipt number: assigned once, now, from the gapless counter (SQL function; falls back to the old
    // count before the migration has been run). Stored on the event, so it never changes afterwards.
    let receiptNumber = null;
    try { receiptNumber = await receiptNumberFor(supabase, { slug, paid_at: paidAt }); }
    catch (e) { console.error("receipt number error:", e); }

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
      `אישורי הגעה ל${oneLine(formData.event_name)} — הפרטים שלך`,
      `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
        <h2 style="color:#1a2744">האירוע מוכן! 🎉</h2>
        <p>שלום ${esc(name)},</p>
        <p><strong>סוג אירוע:</strong> ${esc(typeLabel)}<br/>
        <strong>תאריך:</strong> ${esc(formData.gregorian_date)}<br/>
        <strong>מקום:</strong> ${esc(formData.location)}</p>
        <p><a href="${esc(rsvpUrl)}" style="background:#c9993a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-bottom:8px">🔗 קישור לאורחים</a></p>
        <p><a href="${esc(dashUrl)}" style="background:#1a2744;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">📊 ממשק ניהול הזמנה</a></p>
        <p style="background:#fdf5e0;border:2px dashed #c9993a;border-radius:8px;padding:16px;text-align:center">
          סיסמת ממשק ניהול הזמנה: <strong style="font-size:1.3rem;letter-spacing:.1em">${esc(dashboard_password)}</strong>
        </p>
        <p style="font-size:.82rem;color:#6b7280;background:#f3f4f6;border-radius:8px;padding:10px 14px;margin-top:16px;line-height:1.6">
          🗓️ תזכורת: רשימת האורחים תימחק אוטומטית חודש אחד לאחר תאריך האירוע (${esc(formData.gregorian_date)}).
        </p>
      </div>`
    );

    // 4b. Receipt email with PDF attachment
    try {
      const receipt = await buildReceipt(supabase, { slug, customer_name: name, paid_at: paidAt, receipt_number: receiptNumber });
      const pdfBuffer = await generateReceiptPDF(receipt);
      const printed = String(receipt.receiptNumber).padStart(6, "0");
      await sendEmail(
        email,
        `קבלה מספר ${printed} — Kupernet`,
        `<div dir="rtl" style="font-family:Arial;padding:24px">
          <p>שלום ${esc(name)},</p>
          <p>מצורפת קבלה עבור תשלום אישורי הגעה לאירוע <strong>${esc(formData.event_name)}</strong>.</p>
          <p>תודה שבחרת ב-Kupernet!</p>
        </div>`,
        {
          content: pdfBuffer.toString("base64"),
          name: `קבלה-${printed}.pdf`,
        }
      );
    } catch (e) {
      console.error("Receipt email error:", e);
    }

    // 4c. Admin notification
    try {
      await sendEmail(
        "kuperoy@gmail.com",
        `💰 הזמנה חדשה: ${oneLine(formData.event_name)} (₪99)`,
        `<div dir="rtl" style="font-family:Arial;padding:24px;max-width:520px">
          <h2 style="color:#1a2744">הזמנה חדשה התקבלה 💰</h2>
          <p><strong>אירוע:</strong> ${esc(formData.event_name)} (${esc(typeLabel)})<br/>
          <strong>תאריך האירוע:</strong> ${esc(formData.gregorian_date)}<br/>
          <strong>לקוח:</strong> ${esc(name)}<br/>
          <strong>אימייל:</strong> ${esc(email)}<br/>
          <strong>טלפון:</strong> ${esc(formData.customer_phone || "—")}<br/>
          <strong>Slug:</strong> ${esc(slug)}</p>
          <p><a href="${esc(BASE_URL)}/admin">פתח את פאנל הניהול</a></p>
        </div>`
      );
    } catch (e) {
      console.error("Admin notification error:", e);
    }

    console.log(`✅ Event created via PayPal: ${slug}`);
    // Publish mode never returns the dashboard password (J-03); the legacy path returns it to the
    // buyer who just created that event.
    const out = { slug, event_name: formData.event_name };
    if (!draft) out.dashboard_password = dashboard_password;
    res.status(200).json(out);
  } catch (e) {
    console.error("paypal-capture error:", e);
    if (captured) {
      // Money moved, then something threw (before or after the event was stored): the owner must look.
      await alertUnpublished(orderID, signedSlugForAlert, "exception after capture: " + (e && e.message || "error"));
      return res.status(502).json({ error: POST_CAPTURE_ERROR });
    }
    if (captureAttempted) {
      // The capture request was sent but its answer is unknown (timeout, dropped connection, non-JSON body):
      // PayPal may have taken the money. Tell the owner; the clients show "unknown, contact us" on 502.
      await alertUnpublished(orderID, signedSlugForAlert, "capture status unknown: " + (e && e.message || "error"));
      return res.status(502).json({ error: CAPTURE_UNKNOWN_ERROR });
    }
    res.status(500).json({ error: "שגיאת שרת" });
  }
};
