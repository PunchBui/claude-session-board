#!/bin/bash
# Builds "Claude Session Board.app" into electron/out/. The app points at this repo, so code
# changes need no rebuild: it reloads the window and restarts the server as files change.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
NAME="Claude Session Board"

npm install --no-audit --no-fund
printf '{ "repo": "%s" }\n' "$ROOT" > repo.json

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
SRC="$ROOT/public/icon-512.png"
for size in 16 32 128 256; do
  sips -z "$size" "$size" "$SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$SRC" "$ICONSET/icon_512x512.png"
iconutil -c icns "$ICONSET" -o icon.icns

rm -rf out
npx --no-install electron-packager . "$NAME" --platform=darwin --arch="$ARCH" --icon=icon.icns --out=out --overwrite \
  --ignore='^/out($|/)' --ignore='^/build\.sh$' --ignore='^/\.gitignore$'
APP="out/$NAME-darwin-$ARCH/$NAME.app"
codesign --force --deep --sign - "$APP"
echo "Built electron/$APP"
echo "Drag it to Applications, or run: open \"electron/$APP\""
