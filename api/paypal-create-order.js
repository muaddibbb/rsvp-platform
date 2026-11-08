const { createClient } = require("@supabase/supabase-js");
const { makeCustomId, sameString } = require("./_pay");
const { clientIp, originVerdict, overLimit, HOUR } = require("./_ratelimit");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PAYPAL_BASE = process.env.PAYPAL_SANDBOX === "false"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

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

  if (originVerdict(req) === "mismatch") return res.status(403).json({ error: "Forbidden" });

  try {
    // J-02/J-03: the order is signed by us. With a slug the buyer must prove they own the unpaid draft
    // (its dashboard password, checked here once); without one it is the legacy "new event" order.
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (body.slug != null && typeof body.slug !== "string") return res.status(400).json({ error: "slug לא תקין" });
    if (slug.length > 100) return res.status(400).json({ error: "slug לא תקין" });

    const customId = makeCustomId(slug || null);
    if (!customId) {
      console.error("create-order: no signing key (set ORDER_SIGNING_KEY or PAYPAL_SECRET)");
      return res.status(500).json({ error: "שגיאת שרת" });
    }

    // J-04: 20 orders per IP per hour; with a slug also 10 attempts per IP+slug per hour (password guessing).
    const rules = [["co-ip", clientIp(req), HOUR, 20]];
    if (slug) rules.push(["co-slug", clientIp(req) + "|" + slug, HOUR, 10]);
    if (await overLimit(supabase, req, rules)) {
      res.setHeader("Retry-After", String(HOUR));
      return res.status(429).json({ error: "יותר מדי ניסיונות, נסו שוב מאוחר יותר" });
    }

    if (slug) {
      const { data: draft, error: dErr } = await supabase
        .from("events").select("id, slug, paid_at, dashboard_password").eq("slug", slug).maybeSingle();
      if (dErr) { console.error("create-order draft lookup error:", dErr); return res.status(500).json({ error: "שגיאת מסד נתונים" }); }
      // Unknown slug and wrong password look the same, so this cannot be used to probe for drafts.
      if (!draft || !draft.dashboard_password || !sameString(body.password, draft.dashboard_password)) {
        return res.status(403).json({ error: "סיסמת הניהול שגויה" });
      }
      if (draft.paid_at) return res.status(400).json({ error: "האירוע כבר פורסם" });
    }

    const accessToken = await getAccessToken();
    const order = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          amount: { currency_code: "ILS", value: "99.00" },
          custom_id: customId,
          description: "אישורי הגעה לאירוע",
        }],
      }),
    });
    const orderData = await order.json();
    console.log("PayPal order response:", JSON.stringify(orderData));
    if (!orderData.id) {
      const issue = orderData.details?.[0]?.issue
        || orderData.details?.[0]?.description
        || orderData.message
        || orderData.name
        || "PayPal rejected order";
      return res.status(500).json({ error: issue, raw: orderData });
    }
    res.status(200).json({ id: orderData.id });
  } catch (e) {
    console.error("PayPal create-order error:", e);
    res.status(500).json({ error: e.message });
  }
};
