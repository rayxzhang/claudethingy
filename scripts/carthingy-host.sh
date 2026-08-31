#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"

RUN_DIR="$REPO_ROOT/.carthingy"
PID_FILE="$RUN_DIR/host.pid"
LOG_FILE="$REPO_ROOT/carthingy.log"

carthingy_load_config "$REPO_ROOT"

ADB_BIN="${CAR_THING_ADB:-$(command -v adb || true)}"
NODE_BIN="${CARTHINGY_NODE:-$(command -v node || echo /opt/homebrew/bin/node)}"
PORT="${CARTHINGY_PORT:-8787}"

mkdir -p "$RUN_DIR"

host_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

adb_reverse() {
  local serial="$1"
  [[ -n "$ADB_BIN" ]] || return 0
  [[ -n "$serial" ]] || return 0
  "$ADB_BIN" -s "$serial" reverse "tcp:${PORT}" "tcp:${PORT}" >/dev/null 2>&1 || true
  "$ADB_BIN" -s "$serial" forward "tcp:9222" "tcp:2222" >/dev/null 2>&1 || true
}

start_host() {
  local serial="${1:-}"
  if host_running; then
    return 0
  fi

  if [[ -z "$serial" ]]; then
    serial="$(carthingy_adb_serial "$ADB_BIN")"
  fi
  if [[ -z "$serial" ]]; then
    return 1
  fi

  adb_reverse "$serial"

  carthingy_ensure_kiosk "$REPO_ROOT"

  if [[ ! -x "$NODE_BIN" ]]; then
    carthingy_log "node not found at $NODE_BIN. Set CARTHINGY_NODE in carthingy.conf"
    return 1
  fi

  local node_dir
  node_dir="$(dirname "$NODE_BIN")"

  nohup env \
    PATH="${node_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
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
    EXCLUDE_NEAR_LAT="${EXCLUDE_NEAR_LAT:-}" \
    EXCLUDE_NEAR_LON="${EXCLUDE_NEAR_LON:-}" \
    EXCLUDE_DEST="${EXCLUDE_DEST:-}" \
    CAR_THING_ADB="$ADB_BIN" \
    CAR_THING_SERIAL="$serial" \
    "$NODE_BIN" "$REPO_ROOT/host/server.mjs" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  nohup env \
    PATH="${node_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
    CAR_THING_ADB="$ADB_BIN" \
    CAR_THING_SERIAL="$serial" \
    "$NODE_BIN" "$REPO_ROOT/host/rotary-bridge.mjs" >>"$LOG_FILE" 2>&1 &
  echo $! >"$RUN_DIR/rotary.pid"

  carthingy_log "host started (pid $(cat "$PID_FILE"), device $serial, port $PORT)"
}

stop_host() {
  if [[ -f "$RUN_DIR/rotary.pid" ]]; then
    kill "$(cat "$RUN_DIR/rotary.pid")" 2>/dev/null || true
    rm -f "$RUN_DIR/rotary.pid"
  fi
  if [[ -f "$RUN_DIR/reverse.pid" ]]; then
    kill "$(cat "$RUN_DIR/reverse.pid")" 2>/dev/null || true
    rm -f "$RUN_DIR/reverse.pid"
  fi
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  carthingy_log "host stopped"
}

case "${1:-}" in
  start) start_host "${2:-}" ;;
  reverse) adb_reverse "${2:-}" ;;
  stop) stop_host ;;
  status)
    if host_running; then
      carthingy_log "running (pid $(cat "$PID_FILE"))"
    else
      carthingy_log "not running"
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|status|reverse} [serial]" >&2
    exit 2
    ;;
esac
