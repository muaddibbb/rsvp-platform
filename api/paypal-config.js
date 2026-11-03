// Public: returns only the PayPal client id for the browser SDK. J-18: the former admin-only
// diagnostic (?test=1) that returned a live PayPal token response is gone; nothing here reads
// the secret or calls PayPal.
module.exports = async (req, res) => {
  res.status(200).json({ clientId: process.env.PAYPAL_CLIENT_ID || "" });
};
