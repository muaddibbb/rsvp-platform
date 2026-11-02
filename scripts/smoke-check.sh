#!/usr/bin/env bash
# Read-only production smoke check for rsvp.kupernet.com: GET requests only. Never POST/PATCH/DELETE,
# never /success with a slug, never sends a password or token.
# HEALTH : pages and rewrites answer 200, an unknown event answers 404 (functions + database up),
#          /api/paypal-config has a clientId (value not printed).
# VERSION: the live index/pricing/rsvp/style/theme files are byte-identical to this checkout's public/.
#          After a rollback VERSION DIFFERENT is expected (production serves the previous deployment).
set -u
BASE="${1:-https://rsvp.kupernet.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
health=0; version=0
for p in / /pricing.html /register.html /rsvp/demo /refund.html /tos.html /privacy.html /success /admin /dashboard/smoke-check; do
  code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$BASE$p")"
  echo "$code GET $p (expect 200)"; [ "$code" = "200" ] || health=1
done
code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$BASE/api/event/smoke-check-no-such-event")"
echo "$code GET /api/event/smoke-check-no-such-event (expect 404)"; [ "$code" = "404" ] || health=1
if curl -s -m 20 "$BASE/api/paypal-config" | grep -q '"clientId":"[^"]'; then echo "ok  GET /api/paypal-config has a clientId"; else echo "BAD GET /api/paypal-config"; health=1; fi
for f in index.html pricing.html rsvp.html style.css theme.js; do
  live="$(curl -s -m 20 "$BASE/$f" | shasum -a 256 | cut -c1-64)"; here="$(shasum -a 256 < "$ROOT/public/$f" | cut -c1-64)"
  if [ "$live" = "$here" ]; then echo "same      $f"; else echo "DIFFERENT $f"; version=1; fi
done
[ "$health" = 0 ] && echo "HEALTH PASS" || echo "HEALTH FAIL"
[ "$version" = 0 ] && echo "VERSION MATCH" || echo "VERSION DIFFERENT"
[ "$health" = 0 ] && [ "$version" = 0 ]
