#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.claudethingy.watch"
OLD_LABEL="com.carthingy.watch"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)/${OLD_LABEL}" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/${LABEL}.plist"
rm -f "$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
bash "$REPO_ROOT/scripts/claudethingy-host.sh" stop >/dev/null 2>&1 || true

printf '[install] Autostart removed.\n'
