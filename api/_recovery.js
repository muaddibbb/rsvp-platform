"use strict";
// Pure helpers for the abandoned-checkout recovery email (used by _sweep.js).
// No Supabase import so tests can load it offline.
// Underscore-prefixed so Vercel does not treat it as its own serverless function.

const { esc } = require("./_mail");   // the one escaper (re-exported below)

// True when the buyer already paid an event after (or just before) starting this checkout.
// 60 minutes of slack: errs toward not emailing someone who just paid.
function paidSincePending(p, events) {
  const since = Date.parse(p && p.updated_at);
  if (!Number.isFinite(since)) return false;
  return (events || []).some(e => {
    const paidAt = Date.parse(e && e.paid_at);
    return Number.isFinite(paidAt) && paidAt >= since - 60 * 60 * 1000;
  });
}

// The buyer's own unpaid draft: the exact name+date match, else the only unpaid draft.
// (A buyer who edits step 1 changes the pending row but not the draft, hence the single-draft fallback.)
function pickDraft(p, events) {
  const drafts = (events || []).filter(e => e && e.slug && !e.paid_at && e.active !== false);
  const name = String((p && p.event_name) || "").trim();
  const exact = drafts.filter(e =>
    String(e.event_name || "").trim() === name && e.gregorian_date === (p && p.gregorian_date));
  if (exact.length) return exact[0];
  return drafts.length === 1 ? drafts[0] : null;
}

// Never reads or prints a password: the link carries only the slug.
function buildRecoveryHtml(p, draft, baseUrl) {
  const draftBlock = draft ? `
      <p>האירוע שלך <strong>${esc(draft.event_name)}</strong> שמור אצלנו כטיוטה. אפשר להמשיך מאותה נקודה ולפרסם אותו כאן:</p>
      <p><a href="${esc(baseUrl)}/dashboard/${encodeURIComponent(draft.slug)}" style="background:#1a2744;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">להמשך ופרסום האירוע</a></p>
      <p style="font-size:.85rem;color:#6b7280">לכניסה צריך את סיסמת הניהול מהאימייל "הטיוטה שלך נשמרה" ששלחנו לך.</p>` : "";
  return `<div dir="rtl" style="font-family:Arial;font-size:15px;line-height:1.9;color:#1a1a2e;padding:8px 4px;max-width:520px">
      <p>היי, זה רועי מ <a href="https://rsvp.kupernet.com" style="color:#c9993a">rsvp.kupernet.com</a></p>
      <p>ראינו שהתחלת הרשמה לאישורי הגעה לאירוע ב99 ש״ח דרך האתר שלנו, ולא סיימת. יש משהו שאני יכול לעזור כדי להשלים?</p>${draftBlock}
      <p>שאלות? אפשר להשיב למייל הזה או לכתוב לי בוואטסאפ: <a href="https://wa.me/972546787932" style="color:#c9993a">054-6787932</a></p>
      <p>תודה.</p>
    </div>`;
}

module.exports = { esc, paidSincePending, pickDraft, buildRecoveryHtml };
