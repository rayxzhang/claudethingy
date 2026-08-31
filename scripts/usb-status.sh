#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[usb] %s\n' "$*"; }
warn() { printf '[usb] ! %s\n' "$*"; }
bad() { printf '[usb] ✗ %s\n' "$*"; }
ok() { printf '[usb] ✓ %s\n' "$*"; }

USB_INFO="$(system_profiler SPUSBDataType 2>/dev/null || true)"

if [[ -z "$USB_INFO" ]]; then
  bad "Could not read USB devices."
  exit 1
fi

if echo "$USB_INFO" | grep -q "GX-CHIP"; then
  bad "Car Thing is in burn mode (GX-CHIP). adb will not work in this mode."
  log ""
  log "Fix:"
  log "  1. Leave it plugged in and run:"
  log "       python $REPO_ROOT/.flash/run_superbird.py --continue_boot"
  log "  2. Unplug USB, wait 5 seconds"
  log "  3. Plug back in with NO buttons held"
  log "  4. Wait for Spotify UI (not a black screen)"
  log "  5. Run: adb devices"
  exit 2
fi

if echo "$USB_INFO" | grep -qi "Remote NDIS"; then
  ok "Car Thing adb/RNDIS interface detected."
elif echo "$USB_INFO" | grep -qi "Superbird" && echo "$USB_INFO" | grep -q "0x1d6b"; then
  ok "Car Thing adb gadget detected (Superbird / 1d6b)."
elif echo "$USB_INFO" | grep -qi "Superbird"; then
  bad "Car Thing is visible but not in adb gadget mode yet."
  log "Unplug and replug after boot, then run this again."
  exit 4
else
  bad "No Car Thing detected on USB."
  log ""
  log "Check:"
  log "  • Data-capable USB-C cable (not charge-only)"
  log "  • Plug directly into the Mac (avoid hubs first)"
  log "  • Device powered on and past the Welcome screen"
  exit 5
fi

if ! command -v adb >/dev/null 2>&1; then
  warn "Install adb: brew install --cask android-platform-tools"
  exit 3
fi

adb kill-server >/dev/null 2>&1 || true
adb start-server >/dev/null 2>&1 || true
if adb devices 2>/dev/null | tail -n +2 | grep -q "device$"; then
  ok "adb sees the device."
  adb devices -l
  exit 0
fi

warn "USB looks right but adb still empty. Try another cable/port, then:"
log "  adb kill-server && adb start-server && adb devices"
exit 3
