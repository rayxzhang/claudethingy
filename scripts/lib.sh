#!/usr/bin/env bash

carthingy_repo_root() {
  cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")/.." && pwd
}

carthingy_conf_file() {
  local repo_root="$1"
  if [[ -f "$repo_root/claudethingy.conf" ]]; then
    printf '%s\n' "$repo_root/claudethingy.conf"
  elif [[ -f "$repo_root/carthingy.conf" ]]; then
    printf '%s\n' "$repo_root/carthingy.conf"
  else
    printf '%s\n' "$repo_root/claudethingy.conf"
  fi
}

carthingy_run_dir() {
  local repo_root="$1"
  mkdir -p "$repo_root/.claudethingy"
  printf '%s\n' "$repo_root/.claudethingy"
}

# After sourcing conf, fill TZ from the Mac if still empty.
carthingy_load_config() {
  local repo_root="$1"
  local config
  config="$(carthingy_conf_file "$repo_root")"
  export CARTHINGY_PORT="${CARTHINGY_PORT:-8787}"
  if [[ -f "$config" ]]; then
    # shellcheck disable=SC1090
    source "$config"
  fi
  export CARTHINGY_PORT="${CARTHINGY_PORT:-8787}"
  export CAR_THING_ADB="${CAR_THING_ADB:-$(command -v adb 2>/dev/null || true)}"
  export CARTHINGY_NODE="${CARTHINGY_NODE:-$(carthingy_node_bin || true)}"
  export OFFICE_RADIUS_NM="${OFFICE_RADIUS_NM:-7}"
  export OFFICE_LABEL="${OFFICE_LABEL:-Office}"
  export CARTHINGY_FLIGHTS_REFRESH_MS="${CARTHINGY_FLIGHTS_REFRESH_MS:-15000}"
  export HOTKEY_1="${HOTKEY_1:-Calendar|open -a Calendar}"
  export HOTKEY_2="${HOTKEY_2:-Mail|open -a Mail}"
  export HOTKEY_3="${HOTKEY_3:-Slack|open -a Slack}"
  export HOTKEY_4="${HOTKEY_4:-Safari|open -a Safari}"
  export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-}"
  export CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-}"
  export RADAR_AIRPORTS="${RADAR_AIRPORTS:-}"
  export EXCLUDE_NEAR_LAT="${EXCLUDE_NEAR_LAT:-}"
  export EXCLUDE_NEAR_LON="${EXCLUDE_NEAR_LON:-}"
  export EXCLUDE_DEST="${EXCLUDE_DEST:-}"
  export WEEKLY_RESET="${WEEKLY_RESET:-}"
  if [[ -z "${CARTHINGY_TZ:-}" || "${CARTHINGY_TZ}" == "UTC" ]]; then
    CARTHINGY_TZ="$(carthingy_detect_tz || true)"
  fi
  export CARTHINGY_TZ="${CARTHINGY_TZ:-}"
}

carthingy_node_bin() {
  if [[ -n "${CARTHINGY_NODE:-}" && -x "$CARTHINGY_NODE" ]]; then
    printf '%s\n' "$CARTHINGY_NODE"
    return
  fi
  local bin
  bin="$(command -v node 2>/dev/null || true)"
  if [[ -n "$bin" && -x "$bin" ]]; then
    printf '%s\n' "$bin"
    return
  fi
  if [[ -x /opt/homebrew/bin/node ]]; then
    printf '%s\n' /opt/homebrew/bin/node
    return
  fi
  if [[ -x /usr/local/bin/node ]]; then
    printf '%s\n' /usr/local/bin/node
    return
  fi
  return 1
}

carthingy_node_dir() {
  local bin
  bin="$(carthingy_node_bin || true)"
  if [[ -n "$bin" ]]; then
    dirname "$bin"
  fi
}

# Existing confs never get rewritten by setup.sh. Append the pin if missing.
carthingy_ensure_node_pin() {
  local repo_root="$1"
  local node_bin="${2:-}"
  local config
  config="$(carthingy_conf_file "$repo_root")"
  [[ -f "$config" ]] || return 0
  grep -q '^CARTHINGY_NODE=' "$config" && return 0
  [[ -n "$node_bin" ]] || node_bin="$(carthingy_node_bin || true)"
  [[ -n "$node_bin" ]] || return 0
  printf '\nCARTHINGY_NODE=%s\n' "$node_bin" >> "$config"
}

carthingy_detect_tz() {
  if [[ -n "${CARTHINGY_TZ:-}" && "${CARTHINGY_TZ}" != "UTC" ]]; then
    printf '%s\n' "$CARTHINGY_TZ"
    return
  fi
  local nodedir tz
  nodedir="$(carthingy_node_dir)"
  if [[ -n "$nodedir" && -x "$nodedir/node" ]]; then
    tz="$("$nodedir/node" -e 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone || "")' 2>/dev/null || true)"
    if [[ -n "$tz" && "$tz" != "UTC" ]]; then
      printf '%s\n' "$tz"
      return
    fi
  fi
  if [[ -L /etc/localtime ]]; then
    readlink /etc/localtime | sed -n 's|.*/zoneinfo/||p'
  fi
}

carthingy_adb_serial() {
  local adb_bin="${1:-adb}"
  "$adb_bin" devices 2>/dev/null | tail -n +2 | tr -d '\r' | awk '$2=="device" {print $1; exit}'
}

carthingy_log() {
  printf '[claudethingy] %s\n' "$*"
}

carthingy_ensure_kiosk() {
  local repo_root="$1"
  bash "$repo_root/scripts/ensure-kiosk.sh" >/dev/null 2>&1 || true
}
