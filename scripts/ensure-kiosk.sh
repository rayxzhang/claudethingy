#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"

carthingy_load_config "$REPO_ROOT"

ADB_BIN="${CAR_THING_ADB:-$(command -v adb || true)}"
SERIAL="${CAR_THING_SERIAL:-}"
APP_URL="file:///usr/share/carthingy/index.html"
MARKER="carthingy-kiosk"

log() { carthingy_log "$*"; }

if [[ -z "$ADB_BIN" ]]; then
  exit 0
fi

serial="$(carthingy_adb_serial "$ADB_BIN")"
if [[ -z "$serial" ]]; then
  exit 0
fi

if [[ -n "$SERIAL" && "$SERIAL" != "$serial" ]]; then
  serial="$SERIAL"
fi

adb() {
  "$ADB_BIN" -s "$serial" "$@"
}

kiosk_ok() {
  local count superbird_start
  count="$(adb shell "grep -c '${MARKER}' /etc/supervisord.conf" 2>/dev/null | tr -d '\r' || echo 0)"
  [[ "${count:-0}" -ge 1 ]] || return 1

  superbird_start="$(adb shell "awk '/\\[program:superbird\\]/{f=1} f&&/^autostart=/{print; exit}' /etc/supervisord.conf" 2>/dev/null | tr -d '\r' || true)"
  [[ "$superbird_start" == "autostart=false" ]] || return 1

  adb shell "test -f /usr/share/carthingy/index.html" >/dev/null 2>&1 || return 1
  return 0
}

superbird_running() {
  adb shell "supervisorctl status superbird 2>/dev/null | grep -q RUNNING" >/dev/null 2>&1
}

if kiosk_ok && ! superbird_running; then
  exit 0
fi

log "Kiosk drift detected on $serial. Reapplying…"
bash "$REPO_ROOT/scripts/apply-kiosk.sh"
