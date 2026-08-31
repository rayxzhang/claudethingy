#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.carthingy.watch"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "$PLIST"
bash "$REPO_ROOT/scripts/carthingy-host.sh" stop >/dev/null 2>&1 || true

printf '[install] Autostart removed.\n'
