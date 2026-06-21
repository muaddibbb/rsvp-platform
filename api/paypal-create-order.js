const PAYPAL_BASE = "https://api-m.paypal.com";

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

  try {
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
          description: "אישורי הגעה לאירוע",
        }],
      }),
    });
    const orderData = await order.json();
    console.log("PayPal order response:", JSON.stringify(orderData));
    if (!orderData.id) {
      return res.status(500).json({ error: orderData.message || "PayPal rejected order", details: orderData });
    }
    res.status(200).json({ id: orderData.id });
  } catch (e) {
    console.error("PayPal create-order error:", e);
    res.status(500).json({ error: e.message });
  }
};
