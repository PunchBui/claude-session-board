#!/bin/bash
set -euo pipefail

LABEL="com.user.claude-session-board"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/claude-session-board.log"
TARGET="gui/$(id -u)"
# launchd starts agents with a bare PATH; child processes (claude, and the MCP servers it
# launches via npx/node) need the node dir and the usual tool dirs to be found.
AGENT_PATH="$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ "${1:-}" = "uninstall" ]; then
  launchctl bootout "$TARGET/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "$TARGET/$LABEL" 2>/dev/null || true
launchctl bootstrap "$TARGET" "$PLIST"
echo "Installed $LABEL (node: $NODE, PATH: $AGENT_PATH, log: $LOG)"
