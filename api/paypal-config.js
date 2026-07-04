const crypto = require("crypto");

function authorized(req) {
  const header = req.headers["authorization"] || "";
  const token  = header.replace(/^Bearer\s+/i, "");
  const pass   = process.env.ADMIN_PASSWORD || "";
  if (!pass || !token) return false;
  try { return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(pass)); } catch { return false; }
}

module.exports = async (req, res) => {
  // Admin-only diagnostic: GET /api/paypal-config?test=1
  if (req.query.test && authorized(req)) {
    const clientId = process.env.PAYPAL_CLIENT_ID || "";
    const secret   = process.env.PAYPAL_SECRET    || "";
    const sandbox  = process.env.PAYPAL_SANDBOX;
    const base     = sandbox === "false" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

    const tokenRes = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const data = await tokenRes.json();

    return res.status(200).json({
      environment:     sandbox === "false" ? "LIVE" : "SANDBOX",
      client_id_hint:  clientId.slice(0, 6) + "..." + clientId.slice(-4),
      secret_hint:     secret.slice(0, 4)   + "..." + secret.slice(-4),
      paypal_status:   tokenRes.status,
      paypal_response: data,
    });
  }

  // Normal use: return client ID for the SDK
  res.status(200).json({ clientId: process.env.PAYPAL_CLIENT_ID || "" });
};
