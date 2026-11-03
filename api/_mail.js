"use strict";
// Mail helpers shared by the e-mail-sending endpoints (J-04). Underscore-prefixed: not a function.
// No Supabase import, so tests can load it offline.

// HTML-escape any caller-controlled text before it is put into an e-mail body or an attribute.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"'`]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" }[c]));
}

// Subject lines are plain text, but a CR/LF would still be header injection in some mail stacks.
function oneLine(s) {
  return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
}

module.exports = { esc, oneLine };
