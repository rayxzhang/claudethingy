#!/usr/bin/env bash

carthingy_repo_root() {
  cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")/.." && pwd
}

carthingy_load_config() {
  local repo_root="$1"
  export CARTHINGY_PORT="${CARTHINGY_PORT:-8787}"
  if [[ -f "$repo_root/carthingy.conf" ]]; then
    # shellcheck disable=SC1090
    source "$repo_root/carthingy.conf"
  fi
  export CARTHINGY_PORT="${CARTHINGY_PORT:-8787}"
  export CAR_THING_ADB="${CAR_THING_ADB:-$(command -v adb 2>/dev/null || true)}"
  export OFFICE_RADIUS_NM="${OFFICE_RADIUS_NM:-7}"
  export OFFICE_LABEL="${OFFICE_LABEL:-Office}"
  export CARTHINGY_FLIGHTS_REFRESH_MS="${CARTHINGY_FLIGHTS_REFRESH_MS:-15000}"
  export HOTKEY_1="${HOTKEY_1:-Calendar|open -a Calendar}"
  export HOTKEY_2="${HOTKEY_2:-Mail|open -a Mail}"
  export HOTKEY_3="${HOTKEY_3:-Slack|open -a Slack}"
  export HOTKEY_4="${HOTKEY_4:-Safari|open -a Safari}"
}

carthingy_adb_serial() {
  local adb_bin="${1:-adb}"
  "$adb_bin" devices 2>/dev/null | tail -n +2 | tr -d '\r' | awk '$2=="device" {print $1; exit}'
}

carthingy_log() {
  printf '[carthingy] %s\n' "$*"
}

carthingy_ensure_kiosk() {
  local repo_root="$1"
  bash "$repo_root/scripts/ensure-kiosk.sh" >/dev/null 2>&1 || true
}
