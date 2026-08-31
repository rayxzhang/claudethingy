#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[recover] %s\n' "$*"; }

if ! [[ -x "$REPO_ROOT/.flash/superbird-tool/.venv/bin/python" ]]; then
  log "Flash tools missing. Run ./scripts/flash.sh once first."
  exit 1
fi

log "Attempting to exit burn mode and boot normally…"
python "$REPO_ROOT/.flash/run_superbird.py" --continue_boot || true

log ""
log "Now:"
log "  1. Unplug the Car Thing"
log "  2. Wait 5 seconds"
log "  3. Plug in with NO buttons held"
log "  4. Wait for Spotify UI"
log "  5. Run: ./scripts/usb-status.sh"
log "  6. Then: adb shell id"
