#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLASH_DIR="$REPO_ROOT/.flash"
TOOL_DIR="$FLASH_DIR/superbird-tool"
FIRMWARE_DIR="$FLASH_DIR/firmware/8.9.2-thinglabs"
WAIT_SECONDS="${CARTHINGY_FLASH_WAIT:-600}"

log() { printf '[flash] %s\n' "$*"; }
fail() { printf '[flash] ERROR: %s\n' "$*" >&2; exit 1; }

ensure_firmware() {
  if [[ -d "$FIRMWARE_DIR" && -f "$FIRMWARE_DIR/system_a.ext2" ]]; then
    return
  fi
  mkdir -p "$FLASH_DIR/firmware"
  local zip="$FLASH_DIR/firmware/8.9.2-thinglabs.zip"
  if [[ ! -f "$zip" ]]; then
    log "Downloading Thing Labs 8.9.2 firmware (~293 MB)…"
    curl -L --progress-bar -o "$zip" \
      "https://thingify.tools/files/blob/P3QZbZIDWnp5m_azQFQqP/Sn_vBLpPfJjic6DZtCj6k/IVXX0JDs_B5nDGs5Om0it?name=8.9.2-thinglabs.zip"
  fi
  mkdir -p "$FIRMWARE_DIR"
  unzip -o "$zip" -d "$FIRMWARE_DIR" >/dev/null
}

ensure_tool() {
  if [[ ! -d "$TOOL_DIR" ]]; then
    log "Cloning superbird-tool…"
    git clone --depth 1 https://github.com/ThingLabsOSS/superbird-tool.git "$TOOL_DIR"
  fi
  if [[ ! -x "$TOOL_DIR/.venv/bin/python" ]]; then
    log "Setting up Python environment…"
    python3 -m venv "$TOOL_DIR/.venv"
    "$TOOL_DIR/.venv/bin/pip" install -q --upgrade pip
    "$TOOL_DIR/.venv/bin/pip" install -q \
      "git+https://github.com/pyusb/pyusb" \
      "git+https://github.com/superna9999/pyamlboot" \
      libusb-package
  fi
}

run_superbird() {
  "$TOOL_DIR/.venv/bin/python" "$FLASH_DIR/run_superbird.py" "$@"
}

device_ready() {
  local out
  out=$(run_superbird --find_device 2>&1 || true)
  echo "$out" | grep -qE 'USB Burn Mode \(ready for commands\)|USB Mode \(buttons 1 & 4 held at boot\)'
}

wait_for_burn_mode() {
  log "Waiting for Car Thing in USB burn mode (up to ${WAIT_SECONDS}s)…"
  log ""
  log "A black screen is normal in burn mode."
  log "Do this now:"
  log "  1. Unplug the Car Thing"
  log "  2. Hold preset buttons 1 AND 4"
  log "  3. Plug USB-C in while still holding both"
  log "  4. Wait a few seconds, then release"
  log "  5. Screen should stay dark (that means burn mode worked)"
  log ""

  local start now
  start=$(date +%s)
  while true; do
    if device_ready; then
      log "Burn mode device detected."
      return 0
    fi
    now=$(date +%s)
    if (( now - start >= WAIT_SECONDS )); then
      return 1
    fi
    sleep 2
  done
}

flash_device() {
  log "Flashing Thing Labs 8.9.2 (about 4–11 minutes). Do not unplug."
  run_superbird --restore_device "$FIRMWARE_DIR"
  log "Restore complete. Booting device out of burn mode…"
  run_superbird --continue_boot || true
  log "Unplug and replug USB normally (do not hold any buttons)."
}

verify_adb() {
  local adb_bin=""
  if command -v adb >/dev/null 2>&1; then
    adb_bin="adb"
  elif [[ -x /opt/homebrew/bin/adb ]]; then
    adb_bin="/opt/homebrew/bin/adb"
  else
    log "Flash finished. Install adb with: brew install --cask android-platform-tools"
    return
  fi

  log "Waiting for device to reboot into adb mode…"
  local i
  for i in $(seq 1 60); do
    if "$adb_bin" devices 2>/dev/null | tail -n +2 | grep -q "device$"; then
      if "$adb_bin" shell id 2>/dev/null | grep -q 'uid=0(root)'; then
        log "Success. adb root shell works."
        return 0
      fi
    fi
    sleep 5
  done
  log "Device rebooted but adb not ready yet. Unplug/replug USB and run: adb shell id"
}

main() {
  ensure_tool
  ensure_firmware

  if device_ready; then
    log "Device already in burn mode."
  elif ! wait_for_burn_mode; then
    fail "Timed out waiting for burn mode. Retry after holding presets 1+4 while plugging in."
  fi

  flash_device
  verify_adb

  log ""
  log "Flash complete. Next:"
  log "  cd $REPO_ROOT"
  log "  ./scripts/setup.sh"
  log "  ./scripts/start.sh"
}

main "$@"
