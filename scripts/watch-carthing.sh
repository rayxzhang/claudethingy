#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"

carthingy_load_config "$REPO_ROOT"
ADB_BIN="${CAR_THING_ADB:-$(command -v adb || true)}"

if [[ -z "$ADB_BIN" ]]; then
  carthingy_log "adb not found. Install: brew install --cask android-platform-tools"
  exit 1
fi

while true; do
  serial="$(carthingy_adb_serial "$ADB_BIN")"
  if [[ -n "$serial" ]]; then
    if [[ "${LAST_SERIAL:-}" != "$serial" ]]; then
      carthingy_ensure_kiosk "$REPO_ROOT"
      LAST_SERIAL="$serial"
      KIOSK_TICK=0
    fi
    bash "$REPO_ROOT/scripts/carthingy-host.sh" start "$serial" >/dev/null 2>&1 || true
    KIOSK_TICK=$((KIOSK_TICK + 1))
    if (( KIOSK_TICK >= 60 )); then
      carthingy_ensure_kiosk "$REPO_ROOT"
      KIOSK_TICK=0
    fi
  else
    LAST_SERIAL=""
    KIOSK_TICK=0
    bash "$REPO_ROOT/scripts/carthingy-host.sh" stop >/dev/null 2>&1 || true
  fi
  sleep 5
done
