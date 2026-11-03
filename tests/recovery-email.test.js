"use strict";
// Item 11: the recovery email links back to the buyer's own saved draft, never carries a password,
// and nobody who already paid gets one (J-24). api/_recovery.js is loaded directly; api/_sweep.js is read
// as text, and loaded once more against a stub Supabase client (it creates a client on import) to check
// the grace cutoff of the manual trigger.
// No dependencies, no network, no side effects.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const { esc, paidSincePending, pickDraft, buildRecoveryHtml } = require(path.join(ROOT, "api/_recovery.js"));

const BASE = "https://rsvp.kupernet.com";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const iso = (offsetMin) => new Date(NOW + offsetMin * 60 * 1000).toISOString();
const pending = { event_name: "Bar Mitzvah Dan", gregorian_date: "2027-03-01", updated_at: iso(0), customer_email: "buyer@example.invalid" };
const draft = (extra) => ({ slug: "bar-mitzvah-dan-x1", event_name: "Bar Mitzvah Dan", gregorian_date: "2027-03-01", paid_at: null, active: true, ...extra });

test("paidSincePending skips a buyer who paid on the dashboard after the pending row", () => {
  assert.equal(paidSincePending(pending, [draft({ paid_at: iso(15) })]), true);
  assert.equal(paidSincePending(pending, [draft({ paid_at: iso(-30) })]), true, "within the 60 minute slack");
});

test("paidSincePending does not skip when the only payment was months earlier", () => {
  assert.equal(paidSincePending(pending, [draft({ paid_at: iso(-60 * 24 * 90) })]), false);
  assert.equal(paidSincePending(pending, [draft()]), false, "an unpaid draft is not a payment");
  assert.equal(paidSincePending(pending, []), false);
});

test("paidSincePending is false for a missing or invalid updated_at or paid_at", () => {
  assert.equal(paidSincePending({}, [draft({ paid_at: iso(5) })]), false);
  assert.equal(paidSincePending({ updated_at: "garbage" }, [draft({ paid_at: iso(5) })]), false);
  assert.equal(paidSincePending(null, [draft({ paid_at: iso(5) })]), false);
  assert.equal(paidSincePending(pending, [draft({ paid_at: "garbage" })]), false);
  assert.equal(paidSincePending(pending, [draft({ paid_at: null })]), false);
});

test("pickDraft prefers the exact name+date match", () => {
  const other = draft({ slug: "other-1", event_name: "Something Else" });
  const exact = draft({ slug: "exact-1" });
  assert.equal(pickDraft(pending, [other, exact]).slug, "exact-1");
  assert.equal(pickDraft({ ...pending, event_name: "  Bar Mitzvah Dan " }, [other, exact]).slug, "exact-1", "name is trimmed");
});

test("pickDraft falls back to the only unpaid draft", () => {
  const only = draft({ slug: "only-1", event_name: "Edited in step 1" });
  assert.equal(pickDraft(pending, [only]).slug, "only-1");
});

test("pickDraft returns null when there are two drafts and no exact match", () => {
  const a = draft({ slug: "a-1", event_name: "A" });
  const b = draft({ slug: "b-1", event_name: "B" });
  assert.equal(pickDraft(pending, [a, b]), null);
  assert.equal(pickDraft(pending, []), null);
});

test("pickDraft ignores paid and deactivated events", () => {
  const paid = draft({ slug: "paid-1", paid_at: iso(-5) });
  const off = draft({ slug: "off-1", active: false });
  assert.equal(pickDraft(pending, [paid, off]), null);
  assert.equal(pickDraft(pending, [paid, off, draft({ slug: "ok-1", event_name: "Renamed" })]).slug, "ok-1");
});

test("buildRecoveryHtml links to <base>/dashboard/<slug> when a draft exists", () => {
  const html = buildRecoveryHtml(pending, draft(), BASE);
  assert.ok(html.includes(`href="${BASE}/dashboard/bar-mitzvah-dan-x1"`));
  assert.ok(html.includes("<strong>Bar Mitzvah Dan</strong>"));
  assert.ok(html.includes("להמשך ופרסום האירוע"));
});

test("buildRecoveryHtml has no dashboard link when there is no draft, and always has the wa.me/972546787932 link", () => {
  const withoutDraft = buildRecoveryHtml(pending, null, BASE);
  assert.ok(!withoutDraft.includes("/dashboard/"));
  assert.ok(withoutDraft.includes('href="https://wa.me/972546787932"'));
  assert.ok(buildRecoveryHtml(pending, draft(), BASE).includes('href="https://wa.me/972546787932"'));
});

test("buildRecoveryHtml keeps the two original paragraphs word for word", () => {
  for (const d of [null, draft()]) {
    const html = buildRecoveryHtml(pending, d, BASE);
    assert.ok(html.includes("זה רועי מ"));
    assert.ok(html.includes("ראינו שהתחלת הרשמה לאישורי הגעה לאירוע ב99"));
    assert.ok(html.includes("ש״ח דרך האתר שלנו, ולא סיימת. יש משהו שאני יכול לעזור כדי להשלים?"));
    assert.ok(html.includes("<p>תודה.</p>"));
  }
});

test("an event_name of <img src=x onerror=1> is escaped", () => {
  const html = buildRecoveryHtml(pending, draft({ event_name: "<img src=x onerror=1>" }), BASE);
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
  assert.ok(!html.includes("<img"));
});

test("the email never contains a password", () => {
  const html = buildRecoveryHtml(
    { ...pending, dashboard_password: "SECRET123", password: "SECRET123" },
    draft({ dashboard_password: "SECRET123", password: "SECRET123" }),
    BASE
  );
  assert.ok(!html.includes("SECRET123"));
  assert.ok(!/סיסמ(?:ה|ת)[^<]{0,12}:\s*\S/.test(html), "no 'password: value' pattern");
});

test("esc escapes & < > \" and '", () => {
  assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(5), "5");
});

test("static: _sweep.js never mentions dashboard_password, requires ./_recovery, and still lists the 11 event types", () => {
  const src = fs.readFileSync(path.join(ROOT, "api/_sweep.js"), "utf8");
  assert.ok(!src.includes("dashboard_password"));
  assert.match(src, /require\(\s*["']\.\/_recovery["']\s*\)/);
  for (const t of ["bar_mitzvah", "bat_mitzvah", "wedding", "brit", "brit_bat", "birthday", "bachelor", "bachelorette", "henna", "family", "other"]) {
    assert.ok(new RegExp(`\\b${t}\\s*:`).test(src), `event type ${t} listed`);
  }
});

// J2-01: the manual trigger's grace is a floor of 10 minutes, never a ceiling. Loads the real
// sweepAbandonedCheckouts against a stub client that only records the "updated_at < cutoff" filter.
// With no pending rows the function returns 0 right after the query, so nothing is sent.
test("sweepAbandonedCheckouts grace: ignoreGrace is a 10 minute floor, the cron default stays 20", async () => {
  const cutoffs = [];
  const builder = () => {
    const b = {};
    for (const m of ["select", "eq", "in", "limit", "update", "delete", "insert"]) b[m] = () => b;
    b.lt = (col, value) => { if (col === "updated_at") cutoffs.push(value); return b; };
    b.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
    return b;
  };
  const id = require.resolve("@supabase/supabase-js", { paths: [path.join(ROOT, "api")] });
  require.cache[id] = { id, filename: id, loaded: true, exports: { createClient: () => ({ from: builder }) } };
  delete process.env.BREVO_API_KEY;
  const { sweepAbandonedCheckouts } = require(path.join(ROOT, "api/_sweep.js"));

  const graceUsed = async (opts) => {
    cutoffs.length = 0;
    const before = Date.now();
    await sweepAbandonedCheckouts(opts);
    assert.equal(cutoffs.length, 1, "one grace filter per sweep");
    const minutes = (before - Date.parse(cutoffs[0])) / 60000; // the call ran within a few ms of `before`
    assert.ok(Math.abs(minutes - Math.round(minutes)) < 0.01, "the cutoff is a whole number of minutes ago");
    return Math.round(minutes);
  };

  // manual trigger (ignoreGrace)
  assert.equal(await graceUsed({ ignoreGrace: true }), 10, "no value: 10 minutes (today's behaviour of the admin button)");
  assert.equal(await graceUsed({ ignoreGrace: true, graceMinutes: 0 }), 10, "0 is raised to the floor");
  assert.equal(await graceUsed({ ignoreGrace: true, graceMinutes: 3 }), 10, "a value below 10 is raised to 10");
  assert.equal(await graceUsed({ ignoreGrace: true, graceMinutes: 10 }), 10);
  assert.equal(await graceUsed({ ignoreGrace: true, graceMinutes: 45 }), 45, "a value above 10 is respected");
  // the daily cron (no ignoreGrace) is unchanged
  assert.equal(await graceUsed({}), 20, "cron default");
  assert.equal(await graceUsed(), 20, "cron with no options");
  assert.equal(await graceUsed({ graceMinutes: 5 }), 5, "an explicit value without ignoreGrace is used as is");
});
