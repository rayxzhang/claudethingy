#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"

carthingy_load_config "$REPO_ROOT"
ADB_BIN="${CAR_THING_ADB:-$(command -v adb || true)}"
PID_FILE="$(carthingy_run_dir "$REPO_ROOT")/host.pid"

if [[ -z "$ADB_BIN" ]]; then
  carthingy_log "adb not found. Install: brew install --cask android-platform-tools"
  exit 1
fi

host_up() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

GONE_TICK=0
KIOSK_TICK=0
LAST_SERIAL=""
NEEDS_REVERSE=0

while true; do
  serial="$(carthingy_adb_serial "$ADB_BIN")"
  if [[ -n "$serial" ]]; then
    if [[ "$LAST_SERIAL" != "$serial" ]]; then
      carthingy_ensure_kiosk "$REPO_ROOT"
      bash "$REPO_ROOT/scripts/claudethingy-host.sh" start "$serial" >/dev/null 2>&1 || true
      bash "$REPO_ROOT/scripts/claudethingy-host.sh" reverse "$serial" >/dev/null 2>&1 || true
      LAST_SERIAL="$serial"
      KIOSK_TICK=0
    elif ! host_up; then
      bash "$REPO_ROOT/scripts/claudethingy-host.sh" start "$serial" >/dev/null 2>&1 || true
    elif [[ "$NEEDS_REVERSE" == 1 ]]; then
      bash "$REPO_ROOT/scripts/claudethingy-host.sh" reverse "$serial" >/dev/null 2>&1 || true
    fi
    NEEDS_REVERSE=0
    GONE_TICK=0
    KIOSK_TICK=$((KIOSK_TICK + 1))
    if (( KIOSK_TICK >= 60 )); then
      carthingy_ensure_kiosk "$REPO_ROOT"
      KIOSK_TICK=0
    fi
  else
    NEEDS_REVERSE=1
    GONE_TICK=$((GONE_TICK + 1))
    if (( GONE_TICK >= 12 )); then
      LAST_SERIAL=""
      KIOSK_TICK=0
      bash "$REPO_ROOT/scripts/claudethingy-host.sh" stop >/dev/null 2>&1 || true
      GONE_TICK=0
    fi
  fi
  sleep 5
done
