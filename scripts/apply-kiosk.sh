#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"
carthingy_load_config "$REPO_ROOT"

PORT="${CARTHINGY_PORT:-8787}"
APP_DIR="/usr/share/claudethingy"
OLD_DIR="/usr/share/carthingy"
REV="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || printf '%s' "dev")"
APP_URL="file://${APP_DIR}/index.html?v=${REV}"
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
log "deploying dashboard $REV to $APP_DIR (and $OLD_DIR)"

adb shell "mount -o remount,rw /" >/dev/null

if ! adb shell "test -f /etc/supervisord.conf.stock"; then
  adb shell "cp -n /etc/supervisord.conf /etc/supervisord.conf.stock" || true
fi

push_display() {
  local dest="$1"
  adb shell "mkdir -p $dest" >/dev/null
  adb push "$REPO_ROOT/display/." "$dest/" >/dev/null
  adb shell "grep -q '<title>claudethingy</title>' $dest/index.html" >/dev/null 2>&1 \
    || fail "Push to $dest did not land the new index.html"
}

push_display "$APP_DIR"
push_display "$OLD_DIR"

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
adb shell "supervisorctl stop chromium" >/dev/null 2>&1 || true
adb shell "killall chromium" >/dev/null 2>&1 || true
sleep 1
if ! adb shell "supervisorctl start chromium" >/dev/null 2>&1; then
  adb shell "supervisorctl restart chromium" >/dev/null 2>&1 || \
    adb shell "supervisorctl restart superbird" >/dev/null 2>&1 || \
    fail "Could not restart Chromium. Check: adb shell supervisorctl status"
fi

log "chromium app: $(adb shell "grep -o -- '--app=[^ ]*' /etc/supervisord.conf" 2>/dev/null | tr -d '\r' | head -1)"
log "kiosk applied. Title on device should be claudethingy. Live data needs the host on port $PORT."
