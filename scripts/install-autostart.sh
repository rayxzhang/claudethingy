#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && /bin/pwd -P)"
# shellcheck source=lib.sh
source "$REPO_ROOT/scripts/lib.sh"

carthingy_load_config "$REPO_ROOT"

LABEL="com.claudethingy.watch"
OLD_LABEL="com.carthingy.watch"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# launchd cannot write stdout into ~/Documents (EX_CONFIG 78).
LAUNCHD_LOG="$HOME/Library/Logs/claudethingy.log"
NODE_BIN="$(carthingy_node_bin || true)"
NODE_DIR="$(carthingy_node_dir || true)"
PATH_VALUE="${NODE_DIR:+$NODE_DIR:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
TZ_VALUE="$(carthingy_detect_tz || true)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  printf '[install] ERROR: node not found. Install Node 20+ or set CARTHINGY_NODE.\n' >&2
  exit 1
fi
carthingy_ensure_node_pin "$REPO_ROOT" "$NODE_BIN"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"
mkdir -p "$(carthingy_run_dir "$REPO_ROOT")"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${REPO_ROOT}/scripts/watch-carthing.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH_VALUE}</string>
    <key>CARTHINGY_NODE</key>
    <string>${NODE_BIN}</string>
    <key>CARTHINGY_TZ</key>
    <string>${TZ_VALUE}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LAUNCHD_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LAUNCHD_LOG}</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${OLD_LABEL}" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/${OLD_LABEL}.plist"
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true

PROTECTED=0
case "$REPO_ROOT" in
  */Documents/*|*/Desktop/*|*/Downloads/*) PROTECTED=1 ;;
esac

if [[ "$PROTECTED" == 1 ]]; then
  printf '[install] Wrote %s but did not start it.\n' "$PLIST"
  printf '[install] Repo is in a macOS-protected folder (%s).\n' "$REPO_ROOT"
  printf '[install] launchd cannot read scripts here (Operation not permitted).\n'
  printf '[install] This Mac: keep using ./scripts/start.sh\n'
  printf '[install] Work Mac: clone outside Documents/Desktop/Downloads, then rerun this script.\n'
else
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl enable "gui/$(id -u)/${LABEL}"
  launchctl kickstart -k "gui/$(id -u)/${LABEL}"
  printf '[install] Autostart enabled: %s\n' "$PLIST"
fi

printf '[install] node: %s\n' "${NODE_BIN:-missing}"
printf '[install] PATH: %s\n' "$PATH_VALUE"
printf '[install] Timezone: %s\n' "${TZ_VALUE:-unset}"
printf '[install] Logs: %s\n' "$LAUNCHD_LOG"
