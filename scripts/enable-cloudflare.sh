#!/bin/bash
# Reach the board from anywhere through a Cloudflare quick tunnel (no Cloudflare account needed).
#   ./scripts/enable-cloudflare.sh            start the tunnel and turn remote login on
#   ./scripts/enable-cloudflare.sh rotate     new access token (signs every device out) and a fresh tunnel
#   ./scripts/enable-cloudflare.sh disable    stop the tunnel and turn remote login off
#
# The URL is PUBLIC on the internet; the only protection is the access token login in the board
# (rate-limited per client). A quick tunnel gets a new random *.trycloudflare.com address every
# time cloudflared starts, so after a reboot or `disable` rerun this script and use the new URL.
# For a stable address use a named tunnel on a domain you own and set REMOTE_HOSTS to its hostname.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
CONFIG="$DATA_DIR/remote.json"
PIDFILE="$DATA_DIR/cloudflared.pid"
LOG="$DATA_DIR/cloudflared.log"
PORT="${PORT:-4747}"
LABEL="com.user.claude-session-board"
MODE="${1:-enable}"
CF="$(command -v cloudflared || true)"
[ -n "$CF" ] || { echo "cloudflared is not installed (brew install cloudflared)."; exit 1; }
case "$MODE" in enable|rotate|disable) ;; *) echo "Unknown option: $MODE"; exit 2 ;; esac

stop_tunnel() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

restart_board() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    for _ in $(seq 1 30); do
      curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/health" && return 0
      sleep 0.5
    done
    echo "The board did not come back; check ~/Library/Logs/claude-session-board.log"
    exit 1
  else
    echo "Restart the board (npm start) so it reads $CONFIG."
  fi
}

mkdir -p "$DATA_DIR"
stop_tunnel

if [ "$MODE" = "disable" ]; then
  rm -f "$CONFIG"
  restart_board
  echo "Remote access is off."
  exit 0
fi

TOKEN=""
if [ "$MODE" = "enable" ] && [ -f "$CONFIG" ]; then
  TOKEN="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token||"")}catch{}' "$CONFIG")"
fi
[ -n "$TOKEN" ] || TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"

# The board must already know the hostname, so start the tunnel first and read its address from the log.
: > "$LOG"
nohup "$CF" tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >> "$LOG" 2>&1 &
echo $! > "$PIDFILE"
disown 2>/dev/null || true

HOST=""
for _ in $(seq 1 60); do
  HOST="$(grep -Eo '[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$HOST" ] && break
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "cloudflared stopped; see $LOG"; exit 1; }
  sleep 0.5
done
[ -n "$HOST" ] || { echo "No tunnel address after 30s; see $LOG"; stop_tunnel; exit 1; }

umask 077
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({hosts:[process.argv[2]], token:process.argv[3]}, null, 2)+"\n", {mode:0o600})' "$CONFIG" "$HOST" "$TOKEN"
chmod 600 "$CONFIG"
restart_board

echo
echo "Open on your phone:  https://$HOST/"
echo "Access token (also in $CONFIG):"
echo "  $TOKEN"
