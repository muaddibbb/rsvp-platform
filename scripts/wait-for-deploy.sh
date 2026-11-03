#!/usr/bin/env bash
# Read-only wait for the NEW production deployment of rsvp.kupernet.com. "The new version is live" means the
# deployment identity changed: `npx vercel inspect rsvp.kupernet.com --json` returns an `id` different from the
# recorded previous id AND `readyState` is READY. File hashes are not used here. Never deploys, promotes or rolls back.
# Usage: wait-for-deploy.sh <previous-deployment-id> <seconds 1-360>
# Exit codes:
#   0  DEPLOY READY       the id changed and is READY (go on to the smoke check)
#   2  DEPLOY TIMEOUT     the id never changed (or could not be read) within the deadline: production unchanged, no rollback
#   3  DEPLOY NOT READY   the id changed but readyState was not READY at the deadline: no rollback
#   64 usage error
# Test knobs (offline tests only): WAIT_INSPECT_CMD = path of ONE executable that replaces the inspect command (run
#   directly, no shell evaluation, no arguments); it is honoured ONLY when WAIT_TEST_MODE=1 is also set, so an inherited
#   WAIT_INSPECT_CMD is ignored in real use. WAIT_POLL_INTERVAL = poll interval in seconds, 1-60 (default 10).
set -u
usage() { echo "usage: wait-for-deploy.sh <previous-deployment-id> <seconds 1-360>"; }
[ $# -eq 2 ] || { usage; exit 64; }
PREV="$1"; SECS="$2"
case "$PREV" in ""|-*|*[!A-Za-z0-9_-]*) usage; exit 64 ;; esac
case "$SECS" in ""|0*|*[!0-9]*) usage; exit 64 ;; esac
{ [ "${#SECS}" -le 3 ] && [ "$SECS" -le 360 ]; } || { usage; exit 64; }
INTERVAL="${WAIT_POLL_INTERVAL-10}"
case "$INTERVAL" in ""|0*|*[!0-9]*) usage; exit 64 ;; esac
{ [ "${#INTERVAL}" -le 2 ] && [ "$INTERVAL" -le 60 ]; } || { usage; exit 64; }
INSPECT=""
[ "${WAIT_TEST_MODE:-}" = "1" ] && INSPECT="${WAIT_INSPECT_CMD:-}"
command -v node >/dev/null 2>&1 || { echo "wait-for-deploy.sh needs node to read the inspect JSON"; exit 64; }
TMP="$(mktemp)" || exit 64
trap 'rm -f "$TMP"' EXIT

# read_inspect <max-seconds>: sets cur_id / cur_state ("" when the command failed or printed no usable JSON).
read_inspect() {
  cur_id=""; cur_state=""
  : > "$TMP"
  if [ -n "$INSPECT" ]; then "$INSPECT" > "$TMP" 2>/dev/null & else npx vercel inspect rsvp.kupernet.com --json > "$TMP" 2>/dev/null & fi
  ipid=$!
  # time limit: TERM at the limit, then KILL after a 3 s grace for a command that ignores TERM
  ( sleep "$1"; kill "$ipid" 2>/dev/null; sleep 3; kill -9 "$ipid" 2>/dev/null ) >/dev/null 2>&1 &
  wpid=$!
  wait "$ipid" 2>/dev/null
  pkill -P "$wpid" 2>/dev/null; kill "$wpid" 2>/dev/null; wait "$wpid" 2>/dev/null
  # the two values are joined with "|", so an empty id cannot shift the readyState into the id field
  parsed="$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const ok=(s)=>/^[A-Za-z0-9_-]+$/.test(s)?s:"";process.stdout.write(ok(String(j.id||""))+"|"+ok(String(j.readyState||"")))}catch(e){}' "$TMP" 2>/dev/null)"
  case "$parsed" in
    *"|"*) cur_id="${parsed%%|*}"; cur_state="${parsed#*|}" ;;
  esac
}

start=$SECONDS; last_id=""; last_state=""
while :; do
  remaining=$((SECS - (SECONDS - start)))
  [ "$remaining" -le 0 ] && break
  limit=30; [ "$remaining" -lt "$limit" ] && limit=$remaining
  read_inspect "$limit"
  if [ -n "$cur_id" ]; then
    last_id="$cur_id"; last_state="$cur_state"
    if [ "$cur_id" != "$PREV" ] && [ "$cur_state" = "READY" ]; then
      echo "DEPLOY READY: id changed from $PREV to $cur_id and readyState is READY after $((SECONDS - start)) s"
      exit 0
    fi
    echo "wait: id $cur_id readyState ${cur_state:-unknown} ($((SECONDS - start)) s of $SECS s)"
  else
    echo "wait: inspect gave no usable answer ($((SECONDS - start)) s of $SECS s)"
  fi
  remaining=$((SECS - (SECONDS - start)))
  [ "$remaining" -le 0 ] && break
  nap=$INTERVAL; [ "$remaining" -lt "$nap" ] && nap=$remaining
  sleep "$nap"
done
if [ -n "$last_id" ] && [ "$last_id" != "$PREV" ]; then
  echo "DEPLOY NOT READY after $SECS s: the id changed to $last_id but readyState is ${last_state:-unknown}, not READY. Production was not verified. BLOCKED, no rollback; report this state."
  exit 3
fi
echo "DEPLOY TIMEOUT after $SECS s: the id did not change from $PREV (or inspect could not be read), so production did not change. BLOCKED, no rollback; the owner should check the Vercel dashboard."
exit 2
