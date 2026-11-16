// Picture P2 helpers (underscore name = not a Vercel function). Moves an organizer's checked picture from the
// PRIVATE bucket "picture-staging" (ok/<uuid>.jpg) to the PUBLIC bucket "event-pictures" (pic/<uuid>.jpg) at payment.
// The Supabase client is passed in by the caller. Public names come only from crypto.randomUUID(), never from input.
// attachPicture and removePublic never throw: a picture problem must never break a sale.
const crypto = require("crypto");

const STAGING_BUCKET = "picture-staging";
const PUBLIC_BUCKET = "event-pictures";
const STAGING_RE = /^ok\/[0-9a-f-]{36}\.jpg$/;
const MAX_BYTES = 1572864;

function isStagingPath(p) { return typeof p === "string" && STAGING_RE.test(p); }

function publicUrl(path) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`;
}

async function toBuffer(data) {
  if (data && typeof data.arrayBuffer === "function") return Buffer.from(await data.arrayBuffer());
  return Buffer.from(data);
}

async function stagingExists(supabase, path) {
  try {
    const { data, error } = await supabase.storage.from(STAGING_BUCKET).download(path);
    return !error && !!data;
  } catch (e) { return false; }
}

async function attachPicture(supabase, stagingPath) {
  try {
    const { data, error } = await supabase.storage.from(STAGING_BUCKET).download(stagingPath);
    if (error || !data) return { ok: false, reason: "download failed: " + String((error && error.message) || "no data") };
    const buf = await toBuffer(data);
    if (buf.length < 1 || buf.length > MAX_BYTES) return { ok: false, reason: "bad size: " + buf.length };
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return { ok: false, reason: "not a JPEG" };
    const path = `pic/${crypto.randomUUID()}.jpg`;
    const up = await supabase.storage.from(PUBLIC_BUCKET).upload(path, buf, { contentType: "image/jpeg", upsert: false });
    if (up && up.error) return { ok: false, reason: "upload failed: " + String(up.error.message || "error") };
    // Leto decision: the picture is attached even if the leftover staging object cannot be removed (P3 purges it).
    try {
      const rm = await supabase.storage.from(STAGING_BUCKET).remove([stagingPath]);
      if (rm && rm.error) console.error("picture staging remove failed:", String(rm.error.message || "error"));
    } catch (e) {
      console.error("picture staging remove failed:", String((e && e.message) || e));
    }
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: "exception: " + String((e && e.message) || e) };
  }
}

async function removePublic(supabase, path) {
  try { await supabase.storage.from(PUBLIC_BUCKET).remove([path]); } catch (e) { /* best effort */ }
}

// Deadline for the attach step at capture; read at call time so tests can lower it.
function attachTimeoutMs() {
  const n = Number(process.env.PICTURE_ATTACH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6000;
}

module.exports = { ATTACH_TIMEOUT_MS: 6000, attachTimeoutMs, STAGING_BUCKET, PUBLIC_BUCKET, STAGING_RE, isStagingPath, publicUrl, stagingExists, attachPicture, removePublic };
