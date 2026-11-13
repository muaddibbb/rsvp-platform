// Picture P1: issues a one-time signed upload ticket into the private bucket "picture-staging" ("sign") and
// verifies what was uploaded ("finish": JPEG magic bytes, 1..1.5 MB), promoting it to ok/<uuid>.jpg.
// Object names are built only from crypto.randomUUID() or a strictly validated path, never from user text.
// Nothing here reads or writes the events table. The limiter fails open (see _ratelimit.js).
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const { clientIp, originVerdict, overLimit, HOUR, DAY } = require("./_ratelimit");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = "picture-staging";
const MAX_BYTES = 1572864;
const RAW_RE = /^raw\/[0-9a-f-]{36}\.jpg$/;

function fail(res, status, error) { return res.status(status).json({ error }); }

function isMissingBucket(e) {
  const m = String((e && e.message) || "");
  return /bucket/i.test(m) && /not found/i.test(m);
}

// Maps a storage failure to a fixed message; the real message goes to the log only.
function storageFailure(res, e, notFoundOk) {
  console.error("picture-upload storage error:", String((e && e.message) || e));
  if (isMissingBucket(e)) return fail(res, 503, "Picture upload is not available yet");
  if (notFoundOk && e && (String(e.status) === "404" || String(e.statusCode) === "404" || /not found/i.test(String(e.message || "")))) {
    return fail(res, 404, "Not found");
  }
  return fail(res, 500, "Upload failed");
}

async function toBuffer(data) {
  if (data && typeof data.arrayBuffer === "function") return Buffer.from(await data.arrayBuffer());
  return Buffer.from(data);
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (originVerdict(req) === "mismatch") return res.status(403).json({ error: "Forbidden" });

  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { return fail(res, 400, "Bad request"); }
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "Bad request");
  const action = b.action;
  if (action !== "sign" && action !== "finish") return fail(res, 400, "Bad request");

  // finish: validate the path before the limiter so junk never costs a counter hit.
  if (action === "finish" && (typeof b.path !== "string" || !RAW_RE.test(b.path))) return fail(res, 400, "Bad request");

  const rules = action === "sign"
    ? [
        ["pic-ip-h", clientIp(req), HOUR, 10],
        ["pic-ip-d", clientIp(req), DAY, 30],
        ["pic-all", "global", DAY, 100],
      ]
    : [["pic-fin-ip-h", clientIp(req), HOUR, 30]];
  if (await overLimit(supabase, req, rules)) {
    res.setHeader("Retry-After", String(HOUR));
    return res.status(429).json({ error: "יותר מדי בקשות, נסו שוב מאוחר יותר" });
  }

  try {
    if (action === "sign") {
      const path = `raw/${crypto.randomUUID()}.jpg`;
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) return storageFailure(res, error || { message: "no data" }, false);
      return res.status(200).json({ path, uploadUrl: data.signedUrl, token: data.token });
    }

    const path = b.path;
    const store = supabase.storage.from(BUCKET);
    const dl = await store.download(path);
    if (dl.error || !dl.data) return storageFailure(res, dl.error || { message: "no data" }, true);
    // Blob.size is known without reading the body: refuse an oversize object before loading it into memory.
    const declared = typeof dl.data.size === "number" ? dl.data.size : null;
    const tooBig = declared !== null && declared > MAX_BYTES;
    const buf = tooBig ? null : await toBuffer(dl.data);
    if (tooBig || buf.length < 1 || buf.length > MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
      const rm = await store.remove([path]);
      if (rm && rm.error) console.error("picture-upload remove (rejected) error:", String(rm.error.message || rm.error));
      return fail(res, 422, "הקובץ אינו תמונת JPEG תקינה");
    }
    const okPath = path.replace("raw/", "ok/");
    const cp = await store.copy(path, okPath);
    if (cp.error) return storageFailure(res, cp.error, false);
    const rm = await store.remove([path]);
    if (rm && rm.error) console.error("picture-upload remove (after copy) error:", String(rm.error.message || rm.error));
    return res.status(200).json({ path: okPath });
  } catch (e) {
    console.error("picture-upload error:", String((e && e.message) || e));
    return fail(res, 500, "Upload failed");
  }
};
