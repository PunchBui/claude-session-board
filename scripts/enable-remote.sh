#!/bin/bash
# Reach the board from your phone over Tailscale.
#   ./scripts/enable-remote.sh            turn it on (idempotent; keeps the existing token)
#   ./scripts/enable-remote.sh rotate     make a new token (signs every device out)
#   ./scripts/enable-remote.sh disable    turn it off
#
# The server keeps listening on 127.0.0.1 only. `tailscale serve` publishes it as HTTPS on
# your private tailnet (NOT Tailscale Funnel, which would put it on the public internet),
# and the board asks for an access token from anything that arrives through that hostname.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
CONFIG="$DATA_DIR/remote.json"
PORT="${PORT:-4747}"
LABEL="com.user.claude-session-board"
MODE="${1:-enable}"

TS="$(command -v tailscale || true)"
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
if [ -z "$TS" ]; then
  echo "Tailscale is not installed. Install it on this Mac and on your phone, sign both into the same account, then rerun this script:"
  echo "  Mac:   brew install --cask tailscale   (then open it and sign in)"
  echo "  Phone: App Store / Play Store -> Tailscale"
  exit 1
fi

restart_board() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    echo "Restarted the board."
  else
    echo "Restart the board (npm start, or ./scripts/install-launch-agent.sh) so it reads $CONFIG."
  fi
}

if [ "$MODE" = "disable" ]; then
  "$TS" serve --https=443 off 2>/dev/null || true
  rm -f "$CONFIG"
  restart_board
  echo "Remote access is off."
  exit 0
fi

[ "$MODE" = "enable" ] || [ "$MODE" = "rotate" ] || { echo "Unknown option: $MODE"; exit 2; }

HOST="$("$TS" status --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const n=(JSON.parse(d).Self||{}).DNSName||"";process.stdout.write(n.replace(/\.$/,""))})')"
if [ -z "$HOST" ]; then
  echo "Tailscale is installed but not signed in (or MagicDNS/HTTPS is off). Open Tailscale, sign in, and enable HTTPS certificates in the admin console (DNS tab), then rerun."
  exit 1
fi

mkdir -p "$DATA_DIR"
TOKEN=""
if [ "$MODE" = "enable" ] && [ -f "$CONFIG" ]; then
  TOKEN="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token||"")}catch{}' "$CONFIG")"
fi
[ -n "$TOKEN" ] || TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"

umask 077
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({hosts:[process.argv[2]], token:process.argv[3]}, null, 2)+"\n", {mode:0o600})' "$CONFIG" "$HOST" "$TOKEN"
chmod 600 "$CONFIG"

"$TS" serve --bg --https=443 "http://127.0.0.1:$PORT"
restart_board

echo
echo "Open on your phone (Tailscale must be on):  https://$HOST/"
echo "Access token (also in $CONFIG):"
echo "  $TOKEN"
echo "Then use Share -> Add to Home Screen to install it."
