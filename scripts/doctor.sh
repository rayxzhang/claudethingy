#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
bad() { printf '  ✗ %s\n' "$*"; }

echo "claudethingy doctor"
echo

# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"
carthingy_load_config "$REPO_ROOT"

NODE_BIN="$(carthingy_node_bin || true)"
if [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]]; then
  ok "Node $("$NODE_BIN" --version) ($NODE_BIN)"
else
  bad "Node.js not found. Set CARTHINGY_NODE in claudethingy.conf"
fi

if command -v adb >/dev/null 2>&1; then
  ok "adb $(adb version 2>/dev/null | head -1)"
else
  bad "adb not found (brew install --cask android-platform-tools)"
fi

CREDS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
if [[ -f "$CREDS" ]]; then
  ok "Claude credentials at $CREDS"
elif [[ "$(uname -s)" == "Darwin" ]] && {
  /usr/bin/security find-generic-password -s "Claude Code-credentials" -a "$(id -un)" >/dev/null 2>&1 \
    || /usr/bin/security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1
}; then
  ok "Claude credentials in macOS Keychain (Claude Code-credentials)"
else
  bad "No Claude credentials. Run \`claude\` to sign in."
fi

PROJECTS="${CLAUDE_PROJECTS_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects}"
if [[ -d "$PROJECTS" ]]; then
  NEWEST="$(find "$PROJECTS" -name '*.jsonl' -type f -exec stat -f '%m %N' {} \; 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)"
  if [[ -n "$NEWEST" ]]; then
    ok "Transcripts in $PROJECTS"
    ok "Newest jsonl $(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$NEWEST")"
  else
    warn "No .jsonl files under $PROJECTS"
  fi
else
  bad "No Claude projects dir at $PROJECTS"
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
