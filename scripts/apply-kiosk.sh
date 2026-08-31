#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"
carthingy_load_config "$REPO_ROOT"

PORT="${CARTHINGY_PORT:-8787}"
APP_DIR="/usr/share/claudethingy"
APP_URL="file://${APP_DIR}/index.html"
MARKER="claudethingy-kiosk"

ADB_BIN="${CAR_THING_ADB:-$(command -v adb)}"
SERIAL="${CAR_THING_SERIAL:-}"

log() { printf '[kiosk] %s\n' "$*"; }
fail() { printf '[kiosk] ERROR: %s\n' "$*" >&2; exit 1; }

if [[ -z "$SERIAL" ]]; then
  SERIAL="$("$ADB_BIN" devices 2>/dev/null | tail -n +2 | tr -d '\r' | awk '$2=="device" {print $1; exit}')"
fi

live="$("$ADB_BIN" devices 2>/dev/null | tail -n +2 | tr -d '\r' | awk '$2=="device" {print $1}')"
if [[ -z "$live" ]]; then
  fail "No adb device. Plug in Car Thing, confirm: adb devices"
fi
if ! echo "$live" | grep -qx "$SERIAL"; then
  SERIAL="$(echo "$live" | head -1)"
fi
[[ -n "$SERIAL" ]] || fail "No adb device. Plug in Car Thing and run: adb devices"

adb() {
  "$ADB_BIN" -s "$SERIAL" "$@"
}

log "device: $SERIAL"
log "deploying dashboard to $APP_DIR"

adb shell "mount -o remount,rw /" >/dev/null

if ! adb shell "test -f /etc/supervisord.conf.stock"; then
  adb shell "cp -n /etc/supervisord.conf /etc/supervisord.conf.stock" || true
fi

adb shell "mkdir -p $APP_DIR" >/dev/null
adb push "$REPO_ROOT/display/." "$APP_DIR/" >/dev/null

log "pointing chromium at $APP_URL and disabling Spotify UI"

adb shell "sed -i 's| # carthingy-kiosk||g' /etc/supervisord.conf"
adb shell "sed -i 's| # ${MARKER}||g' /etc/supervisord.conf"
adb shell "sed -i 's|--app=[^ ]*|--app=${APP_URL} # ${MARKER}|g' /etc/supervisord.conf"
adb shell "sed -i '/\\[program:superbird\\]/,/^\\[/ s/^autostart=true/autostart=false/' /etc/supervisord.conf"
adb shell "sed -i '/\\[program:superbird\\]/,/^\\[/ s/^autorestart=true/autorestart=false/' /etc/supervisord.conf"
adb shell "sync" >/dev/null 2>&1 || true

configured="$(adb shell "grep -c '${MARKER}' /etc/supervisord.conf" 2>/dev/null | tr -d '\r' || echo 0)"
if [[ "${configured:-0}" -lt 1 ]]; then
  adb shell "grep app= /etc/supervisord.conf" || true
  fail "Kiosk URL did not stick in /etc/supervisord.conf"
fi

superbird_start="$(adb shell "awk '/\\[program:superbird\\]/{f=1} f&&/^autostart=/{print; exit}' /etc/supervisord.conf" 2>/dev/null | tr -d '\r' || true)"
if [[ "$superbird_start" != "autostart=false" ]]; then
  fail "Could not disable Spotify superbird autostart"
fi

adb shell "supervisorctl stop superbird" >/dev/null 2>&1 || true
adb shell "supervisorctl restart chromium" >/dev/null 2>&1 || \
  adb shell "supervisorctl restart superbird" >/dev/null 2>&1 || true

log "kiosk applied. Live data loads when the host is running (port $PORT)."
