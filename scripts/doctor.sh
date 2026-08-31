#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*"; }

echo "Car Thingy doctor"
echo

if command -v node >/dev/null 2>&1; then
  ok "Node $(node --version)"
else
  bad "Node.js not found"
fi

if command -v adb >/dev/null 2>&1; then
  ok "adb $(adb version 2>/dev/null | head -1)"
else
  bad "adb not found (brew install --cask android-platform-tools)"
fi

CREDS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
if [[ -f "$CREDS" ]]; then
  ok "Claude credentials at $CREDS"
else
  bad "No Claude credentials. Run \`claude\` to sign in."
fi

if command -v adb >/dev/null 2>&1; then
  DEVICES="$(adb devices 2>/dev/null | tail -n +2 | tr -d '\r' | awk '$2=="device" {print $1}')"
  COUNT=0
  if [[ -n "$DEVICES" ]]; then COUNT="$(printf '%s\n' "$DEVICES" | grep -c . || true)"; fi
  if [[ "$COUNT" -eq 1 ]]; then
    ok "Car Thing connected ($(printf '%s' "$DEVICES"))"
    if adb shell "id" 2>/dev/null | grep -q 'uid=0(root)'; then
      ok "adb root shell works (ADB-enabled firmware)"
    else
      warn "adb shell works but not root. You may need the thinglabs firmware (see README)."
    fi
  elif [[ "$COUNT" -eq 0 ]]; then
    bad "No adb device. Plug in Car Thing or run setup."
  else
    warn "Multiple adb devices attached"
  fi
fi

if ioreg -p IOUSB -l -w 0 2>/dev/null | grep -q Superbird; then
  ok "Superbird USB device visible to macOS"
else
  warn "Superbird not visible on USB (normal if already in adb mode on another bus)"
fi

echo
echo "Next steps:"
echo "  ./scripts/setup.sh   # one-time device + kiosk config"
echo "  ./scripts/start.sh   # run dashboard"
