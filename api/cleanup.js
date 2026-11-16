const { createClient } = require("@supabase/supabase-js");
const { sweepAbandonedCheckouts, sendPostEventThankYous } = require("./_sweep");
const { STAGING_BUCKET, PUBLIC_BUCKET, isStagingPath } = require("./_picture");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 30 days after the event date:
//  - Paid events → "close" them: purge the guest RSVP lists (personal data, per the
//    privacy policy) but KEEP the event record (closed/active=false) so the owner can
//    still track past events and download receipts in the admin panel.
//  - Unpaid drafts → delete entirely (junk that never became a real event).
async function closeOrPurgeOldEvents() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 1. Delete unpaid past drafts outright.
  const { data: drafts, error: dErr } = await supabase
    .from("events").select("id").lt("gregorian_date", cutoff).is("paid_at", null);
  if (dErr) throw dErr;
  let deletedDrafts = 0;
  if (drafts && drafts.length) {
    const dids = drafts.map(e => e.id);
    await supabase.from("rsvps").delete().in("event_id", dids);
    const { error } = await supabase.from("events").delete().in("id", dids);
    if (error) throw error;
    deletedDrafts = dids.length;
  }

  // 2. Close paid past events that are still open: snapshot final counts, then delete guest RSVPs,
  //    keep the record. The snapshot preserves headcounts for tracking without keeping personal data.
  //    The snapshot is written once: an event that already has one (closed before, then reactivated by
  //    the owner) is closed again with its saved headcount kept.
  const { data: paidOld, error: pErr } = await supabase
    .from("events").select("id, final_responses, final_guests").lt("gregorian_date", cutoff).not("paid_at", "is", null).eq("active", true);
  if (pErr) throw pErr;
  let closed = 0;
  if (paidOld && paidOld.length) {
    for (const ev of paidOld) {
      const { data: rs } = await supabase
        .from("rsvps").select("attending, guests").eq("event_id", ev.id);
      const rows = rs || [];
      const hasSnapshot = ev.final_responses != null || ev.final_guests != null;
      if (hasSnapshot) {
        // Closed before and reactivated by the owner ("▶️ הפעל" in /admin): close it again but never
        // overwrite the saved headcount (its replies were deleted at the first close, so a recount gives 0/0).
        // Replies received while it was reactivated are deleted below and not added to the count.
        await supabase.from("events").update({ active: false }).eq("id", ev.id);
        if (rows.length) console.warn(`cleanup: event ${ev.id} kept its saved headcount; deleted ${rows.length} reply(ies) received after reactivation`);
      } else {
        const finalResponses = rows.length;
        const finalGuests = rows.filter(r => r.attending).reduce((s, r) => s + (r.guests || 0), 0);
        await supabase.from("events").update({
          active: false,
          final_responses: finalResponses,
          final_guests: finalGuests,
        }).eq("id", ev.id);
      }
      await supabase.from("rsvps").delete().eq("event_id", ev.id);
    }
    closed = paidOld.length;
  }

  return { deletedDrafts, closed };
}

// ---- Picture cleanup (P3). Every step is isolated: it never throws and never changes the steps above. ----
// Only these shapes may ever reach remove(): pic/<uuid>.jpg (event-pictures), ok|raw/<name> (picture-staging).
const PUBLIC_RE = /^pic\/[0-9a-f-]{36}\.jpg$/;
const STAGING_ANY_RE = /^(raw|ok)\/[A-Za-z0-9._-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const isPublicPath = (p) => typeof p === "string" && PUBLIC_RE.test(p);
const isStagingAny = (p) => typeof p === "string" && STAGING_ANY_RE.test(p) && !p.includes("..");
const cutoffDate = () => new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
// Age in ms from created_at (or updated_at); null when unknown (unknown age = keep).
function ageMs(o) {
  const t = Date.parse((o && (o.created_at || o.updated_at)) || "");
  return Number.isFinite(t) ? Date.now() - t : null;
}
async function removeFrom(bucket, paths) {
  if (!paths.length) return true;
  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) { console.error(`picture cleanup: remove from ${bucket} failed:`, error.message || ""); return false; }
  return true;
}

// B (part 1): staged picture paths of the unpaid past drafts, read BEFORE the drafts are deleted.
async function collectDraftPictures() {
  try {
    const { data, error } = await supabase.from("events").select("picture_path")
      .lt("gregorian_date", cutoffDate()).is("paid_at", null).not("picture_path", "is", null);
    if (error) { console.error("picture cleanup: draft picture lookup skipped:", error.code || "", error.message || ""); return []; }
    const out = [];
    for (const r of data || []) {
      if (!r.picture_path) continue;
      if (isStagingPath(r.picture_path)) out.push(r.picture_path);
      else console.error("picture cleanup: ignoring malformed draft picture_path");
    }
    return out;
  } catch (e) { console.error("picture cleanup: draft picture lookup error:", e && e.message); return []; }
}
// B (part 2): best-effort removal once the drafts are gone.
async function removeDraftPictures(paths) {
  try { await removeFrom(STAGING_BUCKET, paths); } catch (e) { console.error("picture cleanup: draft picture remove error:", e && e.message); }
}

// A: past-cutoff events (any active state) with a pic/ path: remove the object, then null the path.
async function purgeClosedEventPictures() {
  let n = 0;
  try {
    const { data, error } = await supabase.from("events").select("id, picture_path")
      .lt("gregorian_date", cutoffDate()).not("picture_path", "is", null)
      .order("gregorian_date", { ascending: true }).limit(50); // at most 50 per night; the rest follow later
    if (error) { console.error("picture cleanup: closed-event lookup skipped:", error.code || "", error.message || ""); return 0; }
    for (const ev of data || []) {
      try {
        if (!ev.picture_path) continue;
        // pic/ = attached picture; ok/ = stale staged path left by a failed attach at capture. Anything else is ignored.
        const bucket = isPublicPath(ev.picture_path) ? PUBLIC_BUCKET : isStagingPath(ev.picture_path) ? STAGING_BUCKET : null;
        if (!bucket) { console.error(`picture cleanup: ignoring malformed picture_path on event ${ev.id}`); continue; }
        if (!(await removeFrom(bucket, [ev.picture_path]))) continue; // keep the path: retried next night
        const { error: uErr } = await supabase.from("events").update({ picture_path: null }).eq("id", ev.id);
        if (uErr) { console.error(`picture cleanup: could not clear picture_path on event ${ev.id}:`, uErr.message || ""); continue; }
        n++;
      } catch (e) { console.error(`picture cleanup: event ${ev && ev.id} error:`, e && e.message); }
    }
  } catch (e) { console.error("picture cleanup: closed-event step error:", e && e.message); }
  return n;
}

// C: staging orphans: raw/ older than 1 day, ok/ older than 14 days.
async function purgeStagingOrphans() {
  let n = 0;
  for (const [folder, maxAge] of [["raw", DAY_MS], ["ok", 14 * DAY_MS]]) {
    try {
      const { data, error } = await supabase.storage.from(STAGING_BUCKET)
        .list(folder, { limit: 1000, offset: 0, sortBy: { column: "created_at", order: "asc" } });
      if (error) { console.error(`picture cleanup: list ${folder}/ failed:`, error.message || ""); continue; }
      const old = [];
      for (const o of data || []) {
        const p = `${folder}/${o && o.name}`;
        const age = ageMs(o);
        if (age === null || age <= maxAge) continue;
        if (!isStagingAny(p)) { console.error(`picture cleanup: ignoring odd staging name in ${folder}/`); continue; }
        old.push(p);
      }
      if (old.length && (await removeFrom(STAGING_BUCKET, old))) n += old.length;
    } catch (e) { console.error(`picture cleanup: staging ${folder}/ error:`, e && e.message); }
  }
  return n;
}

// D: UTC Sundays only: pic/ objects older than 1 day that no event references (checked right before deleting).
async function purgePublicOrphans() {
  if (new Date().getUTCDay() !== 0) return 0;
  let n = 0;
  try {
    const { data, error } = await supabase.storage.from(PUBLIC_BUCKET)
      .list("pic", { limit: 1000, offset: 0, sortBy: { column: "created_at", order: "asc" } });
    if (error) { console.error("picture cleanup: list pic/ failed:", error.message || ""); return 0; }
    const cands = [];
    for (const o of data || []) {
      const p = `pic/${o && o.name}`;
      const age = ageMs(o);
      if (age === null || age <= DAY_MS) continue;
      if (isPublicPath(p)) cands.push(p);
    }
    for (let i = 0; i < cands.length; i += 100) {
      const chunk = cands.slice(i, i + 100);
      const { data: refs, error: rErr } = await supabase.from("events").select("picture_path").in("picture_path", chunk);
      if (rErr || !refs) { console.error("picture cleanup: reference check failed, nothing deleted:", (rErr && rErr.message) || ""); return n; }
      const used = new Set(refs.map(r => r.picture_path));
      const orphans = chunk.filter(p => !used.has(p));
      if (orphans.length && (await removeFrom(PUBLIC_BUCKET, orphans))) n += orphans.length;
    }
  } catch (e) { console.error("picture cleanup: public orphan step error:", e && e.message); }
  return n;
}

module.exports = async (req, res) => {
  // Vercel cron jobs send Authorization: Bearer <CRON_SECRET>
  const auth = req.headers.authorization || "";
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const abandoned = await sweepAbandonedCheckouts();
    const thanked   = await sendPostEventThankYous();
    const draftPictures = await collectDraftPictures();
    const { deletedDrafts, closed } = await closeOrPurgeOldEvents();
    if (deletedDrafts) await removeDraftPictures(draftPictures);
    const picturesRemoved = await purgeClosedEventPictures();
    const stagingPurged = await purgeStagingOrphans();
    const publicOrphansPurged = await purgePublicOrphans();
    // Rate-limit counters older than a day are useless (the longest window is one day): purge them.
    // The table exists only after sql/release-two-migration.sql; before that this just logs.
    try {
      const { error: rlErr } = await supabase.from("rate_limits").delete()
        .lt("window_start", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      if (rlErr) console.error("rate_limits purge skipped:", rlErr.code || "", rlErr.message || "");
    } catch (e) { console.error("rate_limits purge error:", e && e.message); }
    console.log(`Cleanup: thanked ${thanked}, closed ${closed} past event(s), deleted ${deletedDrafts} stale draft(s), notified ${abandoned} abandoned checkout(s), removed ${picturesRemoved} picture(s), purged ${stagingPurged} staging + ${publicOrphansPurged} orphan picture(s)`);
    return res.status(200).json({ thanked, closed, deletedDrafts, abandoned, picturesRemoved, stagingPurged, publicOrphansPurged });
  } catch (err) {
    console.error("cleanup error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
