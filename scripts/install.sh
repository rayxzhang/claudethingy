#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"

log() { carthingy_log "$*"; }
fail() { carthingy_log "ERROR: $*"; exit 1; }

log "Installing claudethingy from $REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 20+ required. Install: brew install node"
fi

major="$(node -p "process.versions.node.split('.')[0]")"
if (( major < 20 )); then
  fail "Node.js 20+ required (found $(node --version))"
fi

if ! command -v adb >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    log "Installing android-platform-tools…"
    brew install --cask android-platform-tools
  else
    fail "adb not found. Install Homebrew, then: brew install --cask android-platform-tools"
  fi
fi

bash "$REPO_ROOT/scripts/setup.sh"

serial="$(carthingy_adb_serial adb || true)"
if [[ -n "$serial" ]]; then
  log "Car Thing detected ($serial). Applying kiosk…"
  bash "$REPO_ROOT/scripts/apply-kiosk.sh"
else
  log "Car Thing not plugged in. After you plug in, run: ./scripts/apply-kiosk.sh"
fi

bash "$REPO_ROOT/scripts/install-autostart.sh"

log ""
log "Install complete."
log ""
log "One manual step per Mac:"
log "  claude    # sign in once (macOS: Keychain; Linux: ~/.claude/.credentials.json)"
log ""
log "Daily use:"
log "  Plug in Car Thing → host starts automatically"
log "  Preview: http://127.0.0.1:8787/"
log "  Logs: $REPO_ROOT/claudethingy.log"
log ""
log "Manual control:"
log "  ./scripts/start.sh              # foreground (debug)"
log "  ./scripts/claudethingy-host.sh status"
log "  ./scripts/uninstall-autostart.sh"
