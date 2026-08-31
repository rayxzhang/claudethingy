#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"

carthingy_load_config "$REPO_ROOT"

ADB_BIN="${CAR_THING_ADB:-$(command -v adb)}"
NODE_BIN="${CARTHINGY_NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
SERIAL="${CAR_THING_SERIAL:-$(carthingy_adb_serial "$ADB_BIN")}"
PORT="${CARTHINGY_PORT:-8787}"

log() { carthingy_log "$*"; }

if system_profiler SPUSBDataType 2>/dev/null | grep -q "GX-CHIP"; then
  log "Car Thing is in USB burn mode. adb reverse will not work."
  log "Fix:"
  log "  1. Keep it plugged in and run: ./scripts/recover-boot.sh"
  log "  2. Unplug, wait 5 seconds, plug in with NO buttons held"
  log "  3. Run: ./scripts/usb-status.sh"
  log "  4. Then: ./scripts/apply-kiosk.sh && ./scripts/start.sh"
  exit 1
fi

if [[ -z "$ADB_BIN" ]]; then
  echo "[carthingy] adb not found. Run: ./scripts/install.sh" >&2
  exit 1
fi

if [[ -z "$SERIAL" ]]; then
  echo "[carthingy] No adb device. Plug in Car Thing." >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "[carthingy] node not found at $NODE_BIN. Set CARTHINGY_NODE in carthingy.conf" >&2
  exit 1
fi

adb_reverse() {
  "$ADB_BIN" -s "$SERIAL" reverse "tcp:${PORT}" "tcp:${PORT}" 2>/dev/null || {
    log "Warning: adb reverse failed. Unplug/replug USB."
  }
  "$ADB_BIN" -s "$SERIAL" forward "tcp:9222" "tcp:2222" >/dev/null 2>&1 || true
}

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    log "Host already running on port $PORT. Nothing to start."
    log "Preview: http://127.0.0.1:${PORT}/"
    log "To restart: kill \$(lsof -ti:${PORT}) && ./scripts/start.sh"
    adb_reverse
    exit 0
  fi
  log "Port $PORT is in use by another process."
  log "Free it with: kill \$(lsof -ti:${PORT})"
  exit 1
fi

log "Foreground mode on port $PORT (device $SERIAL)"
log "Autostart uses: ./scripts/install-autostart.sh"

adb_reverse

env \
  CARTHINGY_PORT="$PORT" \
  OFFICE_LAT="$OFFICE_LAT" \
  OFFICE_LON="$OFFICE_LON" \
  OFFICE_RADIUS_NM="$OFFICE_RADIUS_NM" \
  OFFICE_LABEL="$OFFICE_LABEL" \
  CARTHINGY_FLIGHTS_REFRESH_MS="$CARTHINGY_FLIGHTS_REFRESH_MS" \
  HOTKEY_1="$HOTKEY_1" \
  HOTKEY_2="$HOTKEY_2" \
  HOTKEY_3="$HOTKEY_3" \
  HOTKEY_4="$HOTKEY_4" \
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-}" \
  CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-}" \
  CARTHINGY_TZ="${CARTHINGY_TZ:-}" \
  RADAR_AIRPORTS="${RADAR_AIRPORTS:-}" \
  "$NODE_BIN" "$REPO_ROOT/host/server.mjs" &
SERVER_PID=$!

env \
  CAR_THING_ADB="$ADB_BIN" \
  CAR_THING_SERIAL="$SERIAL" \
  "$NODE_BIN" "$REPO_ROOT/host/rotary-bridge.mjs" &
ROTARY_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$ROTARY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$SERVER_PID"
