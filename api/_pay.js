"use strict";
// Shared payment constants and order signing (J-02, J-03, J-05). Underscore-prefixed: a helper, not a
// serverless function.
//
// Only orders that OUR server created can publish: create-order puts custom_id = "<slug>.<sig>" on the
// PayPal order, capture reads the order back from PayPal and checks the signature. An order made
// directly with the public client id has no valid signature and is refused before any money moves.
const crypto = require("crypto");

const PRICE_ILS = 99;          // the one price; api/paypal-create-order.js keeps the literal "99.00" (pinned by tests)
const CURRENCY = "ILS";
const NEW_EVENT = "new";       // signed in place of a slug for the legacy create-on-capture path
const SIG_LEN = 22;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Key material: ORDER_SIGNING_KEY if set, else derived from PAYPAL_SECRET (no new env var needed).
// `label` separates the uses (order signature, rate-limit key hashing) so one never validates the other.
function deriveKey(label) {
  const explicit = process.env.ORDER_SIGNING_KEY;
  const secret = explicit || process.env.PAYPAL_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update("rsvp-platform|" + label).digest();
}

function sigFor(slugOrNew) {
  const key = deriveKey("order-v1");
  if (!key) return null;
  return crypto.createHmac("sha256", key).update("pub|" + slugOrNew).digest("base64url").slice(0, SIG_LEN);
}

// "<slug>.<sig>" for a draft, "new.<sig>" for the legacy path; null when no key is configured.
function makeCustomId(slug) {
  const subject = slug || NEW_EVENT;
  const sig = sigFor(subject);
  return sig ? `${subject}.${sig}` : null;
}

// -> { valid: false } | { valid: true, slug: "<slug>" } | { valid: true, slug: null } (legacy "new")
function parseCustomId(customId) {
  if (typeof customId !== "string") return { valid: false };
  const dot = customId.lastIndexOf(".");
  if (dot < 1) return { valid: false };
  const subject = customId.slice(0, dot);
  const given = customId.slice(dot + 1);
  const want = sigFor(subject);
  if (!want) return { valid: false };
  // Compare BYTES: a non-ASCII custom_id can have the right character count and the wrong byte count,
  // and timingSafeEqual throws on unequal lengths.
  const g = Buffer.from(given), w = Buffer.from(want);
  if (g.length !== w.length || !crypto.timingSafeEqual(g, w)) return { valid: false };
  return { valid: true, slug: subject === NEW_EVENT ? null : subject };
}

function paypalBase() {
  return process.env.PAYPAL_SANDBOX === "false" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

function sameString(a, b) {
  const x = Buffer.from(String(a == null ? "" : a));
  const y = Buffer.from(String(b == null ? "" : b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { PRICE_ILS, CURRENCY, NEW_EVENT, ORDER_ID_RE, deriveKey, makeCustomId, parseCustomId, paypalBase, sameString };
