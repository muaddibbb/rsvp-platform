"use strict";
// Rate limiting for the public endpoints (J-04) on Vercel Hobby: serverless instances share no memory, so
// the counters live in Supabase (table rate_limits + SQL function rate_limit_hit, see
// sql/release-two-migration.sql). Underscore-prefixed: a helper, not a function.
//
// Honest limits: this raises the cost of abuse (one victim cannot be mailed more than a few times an
// hour from one address); rotating IPs still sprays. It FAILS OPEN: if the database function is missing
// (migration not run) or errors, the request is allowed and the error is logged, so buyers are never
// blocked by infrastructure.
const crypto = require("crypto");
const { deriveKey } = require("./_pay");

// Keys are HMAC hashes: no raw IP or e-mail address is stored.
function hashId(scope, value) {
  const key = deriveKey("ratelimit-v1") || Buffer.from("rsvp-ratelimit-fallback");
  return scope + ":" + crypto.createHmac("sha256", key).update(String(value)).digest("hex").slice(0, 32);
}

// Vercel sets x-forwarded-for (unverified here); first entry = the client.
function clientIp(req) {
  const h = (req && req.headers) || {};
  const xff = String(h["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || String(h["x-real-ip"] || "").trim() || "unknown";
}

// "ok": same-site browser POST, "none": no Origin header (a script; every browser POST sends one),
// "mismatch": an Origin whose host differs from the Host header (a foreign page): refused.
function originVerdict(req) {
  const h = (req && req.headers) || {};
  if (!h.origin) return "none";
  let originHost;
  try { originHost = new URL(h.origin).host; } catch { return "mismatch"; }
  if (!h.host) return "ok";
  return originHost.toLowerCase() === String(h.host).toLowerCase() ? "ok" : "mismatch";
}

// Callers without an Origin header get a quarter of the limit (at least 1).
function effectiveLimit(req, limit) {
  return originVerdict(req) === "none" ? Math.max(1, Math.floor(limit / 4)) : limit;
}

// true = allowed, false = over the limit.
async function allow(supabase, req, scope, id, windowS, limit) {
  const lim = effectiveLimit(req, limit);
  try {
    const { data, error } = await supabase.rpc("rate_limit_hit", { p_key: hashId(scope, id), p_window_s: windowS, p_limit: lim });
    if (error) { console.error("rate limit unavailable (failing open):", scope, error.code || "", error.message || ""); return true; }
    return data !== false;
  } catch (e) {
    console.error("rate limit error (failing open):", scope, e && e.message);
    return true;
  }
}

// rules: [[scope, id, windowSeconds, limit], ...]; true when ANY rule is over its limit (stops at the first).
async function overLimit(supabase, req, rules) {
  for (const [scope, id, windowS, limit] of rules) {
    if (!(await allow(supabase, req, scope, id, windowS, limit))) return true;
  }
  return false;
}

const HOUR = 3600;
const DAY = 86400;

module.exports = { hashId, clientIp, originVerdict, effectiveLimit, allow, overLimit, HOUR, DAY };
