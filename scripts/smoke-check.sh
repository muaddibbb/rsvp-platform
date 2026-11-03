#!/usr/bin/env bash
# Read-only production smoke check for rsvp.kupernet.com: GET requests only. Never POST/PATCH/DELETE,
# never /success with a slug, never sends a password or token.
# HEALTH : pages and rewrites answer 200, an unknown event answers 404 (functions + database up),
#          /api/paypal-config has a clientId (value not printed).
# VERSION: the live index/pricing/rsvp/style/theme files are byte-identical to this checkout's public/.
#          This is an extra signal only: whether a NEW deployment is live is decided by wait-for-deploy.sh (deployment id).
#          After a rollback VERSION DIFFERENT is expected (production serves the previous deployment).
# Usage: smoke-check.sh [--wait <seconds 1-540>] [base-url]   (--wait may stand before or after the base url;
#          base-url must be https://... or http://127.0.0.1:...)
#   --wait <seconds>: before the full checks, poll (GET only, every 15 s) until the VERSION lines say MATCH. On timeout
#          print "VERSION TIMEOUT" and exit 2 without running the health checks. Without --wait: one pass, no polling.
# One overall deadline covers polling and checks: 180 s without --wait, min(<wait> + 180, 540) s with it. Every request is limited to 10 s (-m 10).
#   When the deadline passes the script prints "SMOKE DEADLINE" and exits 2 (not verified).
# Exit codes: 0 pass, 1 HEALTH or VERSION failed, 2 timeout / deadline (not verified), 64 usage.
# Test knobs (offline tests only): SMOKE_POLL_INTERVAL = poll interval in seconds, 1-60 (default 15);
#   SMOKE_DEADLINE = overall deadline in seconds, 1-540.
set -u
usage() { echo "usage: smoke-check.sh [--wait <seconds 1-540>] [base-url (https://... or http://127.0.0.1:...)]"; }
WAIT=""; wait_given=0; BASE="https://rsvp.kupernet.com"; have_base=0
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) { [ $# -ge 2 ] && [ "$wait_given" = 0 ]; } || { usage; exit 64; }; WAIT="$2"; wait_given=1; shift 2 ;;
    -*) usage; exit 64 ;;
    *) [ "$have_base" = 0 ] || { usage; exit 64; }; BASE="$1"; have_base=1; shift ;;
  esac
done
case "$BASE" in https://*|http://127.0.0.1:*) ;; *) usage; exit 64 ;; esac
if [ "$wait_given" = 1 ]; then
  case "$WAIT" in ""|0*|*[!0-9]*) usage; exit 64 ;; esac
  { [ "${#WAIT}" -le 3 ] && [ "$WAIT" -le 540 ]; } || { usage; exit 64; }
fi
INTERVAL="${SMOKE_POLL_INTERVAL-15}"
case "$INTERVAL" in ""|0*|*[!0-9]*) usage; exit 64 ;; esac
{ [ "${#INTERVAL}" -le 2 ] && [ "$INTERVAL" -le 60 ]; } || { usage; exit 64; }
if [ -n "$WAIT" ]; then TOTAL=$((WAIT + 180)); [ "$TOTAL" -gt 540 ] && TOTAL=540; else TOTAL=180; fi
if [ -n "${SMOKE_DEADLINE:-}" ]; then
  case "$SMOKE_DEADLINE" in 0*|*[!0-9]*) usage; exit 64 ;; esac
  { [ "${#SMOKE_DEADLINE}" -le 3 ] && [ "$SMOKE_DEADLINE" -le 540 ]; } || { usage; exit 64; }
  TOTAL="$SMOKE_DEADLINE"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T0=$SECONDS
health=0; version=0
deadline_check() {
  if [ $((SECONDS - T0)) -ge "$TOTAL" ]; then echo "SMOKE DEADLINE after $TOTAL s: production was not verified (slow or unreachable)"; exit 2; fi
}
# check_version <quiet|loud>: sets $version (0 = every live file is byte-identical to this checkout's public/).
check_version() {
  version=0
  for f in index.html pricing.html rsvp.html style.css theme.js; do
    deadline_check
    live="$(curl -s -m 10 "$BASE/$f" | shasum -a 256 | cut -c1-64)"; here="$(shasum -a 256 < "$ROOT/public/$f" | cut -c1-64)"
    if [ "$live" = "$here" ]; then [ "$1" = loud ] && echo "same      $f"; else [ "$1" = loud ] && echo "DIFFERENT $f"; version=1; fi
  done
}
if [ -n "$WAIT" ]; then
  start=$SECONDS
  while :; do
    check_version quiet
    [ "$version" = 0 ] && { echo "wait: live files match this checkout after $((SECONDS - start)) s"; break; }
    if [ $((SECONDS - start)) -ge "$WAIT" ]; then echo "VERSION TIMEOUT after $WAIT s: the live files did not match this checkout (unreachable, still building, or another version)"; exit 2; fi
    echo "wait: VERSION DIFFERENT ($((SECONDS - start)) s of $WAIT s), next poll in $INTERVAL s"
    sleep "$INTERVAL"
  done
fi
for p in / /pricing.html /register.html /rsvp/demo /refund.html /tos.html /privacy.html /success /admin /dashboard/smoke-check; do
  deadline_check
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE$p")"
  echo "$code GET $p (expect 200)"; [ "$code" = "200" ] || health=1
done
deadline_check
code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE/api/event/smoke-check-no-such-event")"
echo "$code GET /api/event/smoke-check-no-such-event (expect 404)"; [ "$code" = "404" ] || health=1
deadline_check
if curl -s -m 10 "$BASE/api/paypal-config" | grep -q '"clientId":"[^"]'; then echo "ok  GET /api/paypal-config has a clientId"; else echo "BAD GET /api/paypal-config"; health=1; fi
check_version loud
[ "$health" = 0 ] && echo "HEALTH PASS" || echo "HEALTH FAIL"
[ "$version" = 0 ] && echo "VERSION MATCH" || echo "VERSION DIFFERENT"
[ "$health" = 0 ] && [ "$version" = 0 ]
