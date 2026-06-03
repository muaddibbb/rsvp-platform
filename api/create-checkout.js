const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BASE_URL = "https://rsvp.kupernet.com";
const PRICE_AGOROT = 9900; // ₪99

// Hebrew → Latin transliteration for slug
const HE_MAP = {
  א:"a",ב:"b",ג:"g",ד:"d",ה:"h",ו:"v",ז:"z",ח:"h",ט:"t",י:"y",
  כ:"k",ך:"k",ל:"l",מ:"m",ם:"m",נ:"n",ן:"n",ס:"s",ע:"a",פ:"p",
  ף:"p",צ:"tz",ץ:"tz",ק:"k",ר:"r",ש:"sh",ת:"t"
};

function hebrewToLatin(str) {
  return str
    .replace(/[֑-ׇ]/g, "") // strip niqqud
    .split("")
    .map(c => HE_MAP[c] || (c.match(/[a-zA-Z0-9]/) ? c.toLowerCase() : ""))
    .join("")
    .slice(0, 12);
}

function generatePassword() {
  return crypto.randomBytes(6).toString("base64url"); // 8 URL-safe chars
}

async function generateSlug(eventType, customerName, year) {
  const typeMap = {
    bar_mitzvah: "bm", wedding: "wedding", brit: "brit",
    birthday: "bday", other: "event"
  };
  const prefix = typeMap[eventType] || "event";
  const lastName = customerName.trim().split(/\s+/).pop();
  const base = `${prefix}-${hebrewToLatin(lastName) || "il"}-${year}`;

  // Check collision
  const { data } = await supabase.from("events").select("slug").eq("slug", base).maybeSingle();
  if (!data) return base;

  // Append random suffix
  const suffix = crypto.randomBytes(2).toString("hex");
  return `${base}-${suffix}`;
}

function validate(body) {
  const required = ["event_type","event_name","gregorian_date","event_time",
                    "location","address","customer_name","customer_email"];
  for (const field of required) {
    if (!body[field] || !String(body[field]).trim()) {
      return `Missing required field: ${field}`;
    }
  }
  if (!/^\S+@\S+\.\S+$/.test(body.customer_email)) return "Invalid email";
  return null;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const err = validate(body);
  if (err) return res.status(400).json({ error: err });

  try {
    const year = new Date(body.gregorian_date).getFullYear() || new Date().getFullYear();
    const slug = await generateSlug(body.event_type, body.customer_name, year);
    const dashboard_password = generatePassword();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      currency: "ils",
      customer_email: body.customer_email,
      line_items: [{
        price_data: {
          currency: "ils",
          unit_amount: PRICE_AGOROT,
          product_data: {
            name: `אישורי הגעה — ${body.event_name}`,
            description: `${body.event_type === "bar_mitzvah" ? "בר מצווה" : body.event_type === "wedding" ? "חתונה" : body.event_type === "brit" ? "ברית" : "אירוע"} · ${body.gregorian_date}`,
          },
        },
        quantity: 1,
      }],
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/register`,
      metadata: {
        slug,
        dashboard_password,
        event_type:        body.event_type,
        event_name:        body.event_name,
        hebrew_date:       body.hebrew_date        || "",
        gregorian_date:    body.gregorian_date,
        event_time:        body.event_time,
        location:          body.location,
        address:           body.address,
        extra_note:        body.extra_note          || "",
        customer_name:     body.customer_name,
        customer_email:    body.customer_email,
        customer_phone:    body.customer_phone      || "",
      },
    });

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout error:", e);
    res.status(500).json({ error: "Server error" });
  }
};
